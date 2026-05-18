use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    io,
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, Method, StatusCode, header::HeaderName},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use regex::Regex;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::{
    fs,
    process::Command,
    time::{Instant, timeout},
};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing::{error, info};
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    artifacts: ArtifactStore,
}

type ArtifactStore = Arc<Mutex<HashMap<String, CompileArtifact>>>;

#[derive(Clone)]
struct Config {
    port: u16,
    cors_origin: String,
    max_upload_bytes: usize,
    compile_timeout: Duration,
    compiler_mode: CompilerMode,
    latexmk_bin: String,
    tectonic_bin: String,
    synctex_bin: String,
    compiler_extra_path: Vec<PathBuf>,
    enable_xelatex: bool,
    enable_lualatex: bool,
    tectonic_cache_dir: PathBuf,
    compile_work_dir: PathBuf,
    artifact_dir: PathBuf,
    artifact_ttl: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompilerMode {
    Auto,
    Latexmk,
    Tectonic,
}

impl CompilerMode {
    fn as_log_label(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Latexmk => "latexmk",
            Self::Tectonic => "tectonic",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum CompilerName {
    Latexmk,
    Tectonic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
enum CompilerEngine {
    #[serde(rename = "pdflatex")]
    PdfLaTeX,
    #[serde(rename = "xelatex")]
    XeLaTeX,
    #[serde(rename = "lualatex")]
    LuaLaTeX,
    #[serde(rename = "tectonic")]
    Tectonic,
}

impl CompilerEngine {
    fn as_log_label(self) -> &'static str {
        match self {
            Self::PdfLaTeX => "pdflatex",
            Self::XeLaTeX => "xelatex",
            Self::LuaLaTeX => "lualatex",
            Self::Tectonic => "tectonic",
        }
    }
}

impl CompilerName {
    fn as_log_label(self) -> &'static str {
        match self {
            Self::Latexmk => "latexmk",
            Self::Tectonic => "tectonic",
        }
    }
}

#[derive(Clone)]
struct CompileArtifact {
    created_at: SystemTime,
    pdf_path: PathBuf,
    synctex_path: Option<PathBuf>,
    original_workspace: PathBuf,
    source_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompileRequest {
    project_title: Option<String>,
    root_file_path: String,
    files: Vec<ProjectFilePayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFilePayload {
    path: String,
    content_text: Option<String>,
    content_base64: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SynctexReverseRequest {
    compile_id: String,
    page: u32,
    x: f64,
    y: f64,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    ok: bool,
    compiler: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileSuccessResponse {
    ok: bool,
    compile_id: String,
    compiler: CompilerName,
    engine: CompilerEngine,
    duration_ms: u128,
    filename: String,
    pdf_base64: String,
    log: String,
    diagnostics: Vec<CompileDiagnostic>,
    synctex_available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    ok: bool,
    compiler: String,
    engine: Option<CompilerEngine>,
    code: ErrorCode,
    log: String,
    diagnostics: Vec<CompileDiagnostic>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileDiagnostic {
    severity: DiagnosticSeverity,
    title: String,
    message: String,
    file_path: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    excerpt: Option<String>,
    category: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ErrorCode {
    BadRequest,
    UnsupportedEngine,
    MissingCompiler,
    Timeout,
    CompileFailed,
    Io,
}

#[derive(Debug)]
struct CompileOutput {
    pdf: Bytes,
    log: String,
    filename: String,
    compiler: CompilerName,
    engine: CompilerEngine,
    duration_ms: u128,
    diagnostics: Vec<CompileDiagnostic>,
    synctex_bytes: Option<Bytes>,
    workspace_path: PathBuf,
    source_paths: Vec<String>,
}

#[derive(Debug)]
struct CompilerRun {
    status: i32,
    log: String,
    compiler: CompilerName,
    engine: CompilerEngine,
}

#[derive(Debug, Error)]
enum CompileError {
    #[error("Request does not include any files.")]
    EmptyFileSet,
    #[error("Unsafe path: {0}")]
    UnsafePath(String),
    #[error("Root file was not included in the request: {0}")]
    MissingRoot(String),
    #[error("File has no content: {0}")]
    MissingContent(String),
    #[error("Invalid base64 content for {path}: {source}")]
    InvalidBase64 {
        path: String,
        source: base64::DecodeError,
    },
    #[error(
        "{engine} is detected, but this Render compiler profile only supports PDFLaTeX. Switch template/packages or enable that engine later."
    )]
    UnsupportedEngine {
        engine: &'static str,
        detected: CompilerEngine,
    },
    #[error("{compiler} executable was not found. Tried: {bin}")]
    MissingCompiler {
        compiler: &'static str,
        bin: String,
        engine: Option<CompilerEngine>,
        #[source]
        source: io::Error,
    },
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Compiler timed out after {0} seconds.")]
    Timeout(u64),
    #[error("Compiler failed with status {status}.\n{log}")]
    CompilerFailed {
        status: i32,
        log: String,
        compiler: CompilerName,
        engine: CompilerEngine,
    },
}

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();

    load_env_files();
    let config = Arc::new(Config::from_env());
    fs::create_dir_all(&config.tectonic_cache_dir).await?;
    fs::create_dir_all(&config.artifact_dir).await?;

    let state = AppState {
        config: Arc::clone(&config),
        artifacts: Arc::new(Mutex::new(HashMap::new())),
    };

    let router = Router::new()
        .route("/health", get(health))
        .route("/compile", post(compile))
        .route("/synctex/reverse", post(synctex_reverse))
        .layer(DefaultBodyLimit::max(config.max_upload_bytes))
        .layer(cors_layer(&config.cors_origin))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let address = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(address).await?;
    info!("Moss compiler backend listening on {address}");
    log_backend_config(&config);
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
}

fn load_env_files() {
    let current_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let parent_dir = current_dir.parent().map(Path::to_path_buf);
    let mut candidates = vec![current_dir.join(".env"), current_dir.join(".env.local")];
    if let Some(parent) = parent_dir {
        candidates.push(parent.join(".env"));
        candidates.push(parent.join(".env.local"));
    }

    for path in candidates {
        if path.exists() {
            match dotenvy::from_path_override(&path) {
                Ok(_) => {
                    info!(path = %path.display(), "Loaded Moss backend env file with override")
                }
                Err(error) => {
                    error!(path = %path.display(), %error, "Failed to load Moss backend env file")
                }
            }
        }
    }
}

fn log_backend_config(config: &Config) {
    const ORANGE: &str = "\x1b[38;5;208m";
    const RESET: &str = "\x1b[0m";
    let extra_path = format_path_list(&config.compiler_extra_path);
    println!(
        "{ORANGE}Moss backend config: mode={} latexmk={} tectonic={} synctex={} timeout={}ms work_dir={} extra_path={}{RESET}",
        config.compiler_mode.as_log_label(),
        config.latexmk_bin,
        config.tectonic_bin,
        config.synctex_bin,
        config.compile_timeout.as_millis(),
        config.compile_work_dir.display(),
        extra_path,
    );
    info!(
        mode = config.compiler_mode.as_log_label(),
        latexmk = %config.latexmk_bin,
        tectonic = %config.tectonic_bin,
        synctex = %config.synctex_bin,
        timeout_ms = config.compile_timeout.as_millis(),
        work_dir = %config.compile_work_dir.display(),
        extra_path = %extra_path,
        "Moss backend config"
    );
}

impl Config {
    fn from_env() -> Self {
        let port = env::var("PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(8787);
        let max_upload_mb = env::var("MAX_UPLOAD_MB")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(80);
        let compile_timeout_ms = env::var("COMPILE_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(60_000);
        let artifact_ttl_ms = env::var("COMPILE_ARTIFACT_TTL_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(600_000);
        let artifact_dir = env::var_os("COMPILE_ARTIFACT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| env::temp_dir().join("moss-compile-artifacts"));
        let tectonic_cache_dir = env::var_os("TECTONIC_CACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                env::current_dir()
                    .unwrap_or_else(|_| env::temp_dir())
                    .join(".tectonic-cache")
            });
        let compile_work_dir = env::var_os("COMPILE_WORK_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                env::current_dir()
                    .unwrap_or_else(|_| env::temp_dir())
                    .join(".compile-tmp")
            });

        Self {
            port,
            cors_origin: env::var("CORS_ORIGIN").unwrap_or_else(|_| "*".to_string()),
            max_upload_bytes: max_upload_mb * 1024 * 1024,
            compile_timeout: Duration::from_millis(compile_timeout_ms),
            compiler_mode: compiler_mode_from_env(),
            latexmk_bin: env::var("LATEXMK_BIN").unwrap_or_else(|_| "latexmk".to_string()),
            tectonic_bin: discover_tectonic_bin(),
            synctex_bin: env::var("SYNCTEX_BIN").unwrap_or_else(|_| "synctex".to_string()),
            compiler_extra_path: compiler_extra_path_from_env(),
            enable_xelatex: env_flag("ENABLE_XELATEX"),
            enable_lualatex: env_flag("ENABLE_LUALATEX"),
            tectonic_cache_dir,
            compile_work_dir,
            artifact_dir,
            artifact_ttl: Duration::from_millis(artifact_ttl_ms),
        }
    }
}

fn compiler_mode_from_env() -> CompilerMode {
    match env::var("MOSS_COMPILER_ENGINE")
        .unwrap_or_else(|_| "auto".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "latexmk" => CompilerMode::Latexmk,
        "tectonic" => CompilerMode::Tectonic,
        _ => CompilerMode::Auto,
    }
}

fn compiler_extra_path_from_env() -> Vec<PathBuf> {
    env::var_os("COMPILER_EXTRA_PATH")
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default()
}

fn format_path_list(paths: &[PathBuf]) -> String {
    if paths.is_empty() {
        return "-".to_string();
    }

    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(";")
}

fn env_flag(name: &str) -> bool {
    matches!(
        env::var(name).ok().as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES")
    )
}

fn discover_tectonic_bin() -> String {
    if let Ok(value) = env::var("TECTONIC_BIN") {
        let path = PathBuf::from(&value);
        if path.exists() {
            return value;
        }
    }

    let local_candidates = [
        PathBuf::from("bin").join("tectonic.exe"),
        PathBuf::from("backend").join("bin").join("tectonic.exe"),
        PathBuf::from("tectonic.exe"),
    ];

    local_candidates
        .into_iter()
        .find(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tectonic".to_string())
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        compiler: "moss-compiler",
    })
}

async fn compile(State(state): State<AppState>, Json(request): Json<CompileRequest>) -> Response {
    cleanup_expired_artifacts(&state).await;

    match compile_project(&state.config, request).await {
        Ok(output) => match success_response(&state, output).await {
            Ok(response) => response,
            Err(error) => {
                error!(%error, "compile response failed");
                error_response(error)
            }
        },
        Err(error) => {
            error!(%error, "compile failed");
            error_response(error)
        }
    }
}

async fn synctex_reverse(
    State(state): State<AppState>,
    Json(request): Json<SynctexReverseRequest>,
) -> Response {
    cleanup_expired_artifacts(&state).await;

    let artifact = {
        let guard = state.artifacts.lock().expect("artifact store poisoned");
        guard.get(&request.compile_id).cloned()
    };

    let Some(artifact) = artifact else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "ok": false,
                "error": "Compile artifact expired. Recompile and try again."
            })),
        )
            .into_response();
    };

    if artifact.synctex_path.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "ok": false,
                "error": "SyncTeX output is not available for this compile."
            })),
        )
            .into_response();
    }

    match run_synctex_reverse(&state.config, &artifact, &request).await {
        Ok(location) => (StatusCode::OK, Json(location)).into_response(),
        Err(error) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({
                "ok": false,
                "error": error.to_string()
            })),
        )
            .into_response(),
    }
}

async fn compile_project(
    config: &Config,
    request: CompileRequest,
) -> Result<CompileOutput, CompileError> {
    if request.files.is_empty() {
        return Err(CompileError::EmptyFileSet);
    }

    let root_path = safe_project_path(&request.root_file_path)?;
    fs::create_dir_all(&config.compile_work_dir).await?;
    let work_dir = tempfile::Builder::new()
        .prefix("moss-compile-")
        .tempdir_in(&config.compile_work_dir)?;
    let workspace_path = work_dir.path().to_path_buf();
    let output_dir = workspace_path.join("out");
    fs::create_dir_all(&output_dir).await?;

    let mut root_content = String::new();
    let mut root_seen = false;
    let mut source_paths = Vec::new();
    for file in &request.files {
        let relative_path = safe_project_path(&file.path)?;
        root_seen |= relative_path == root_path;
        if relative_path == root_path {
            root_content = file.content_text.clone().unwrap_or_default();
        }
        if file.content_text.is_some() {
            source_paths.push(path_to_string(&relative_path));
        }
        write_project_file(&workspace_path, &relative_path, file).await?;
    }

    if !root_seen {
        return Err(CompileError::MissingRoot(request.root_file_path));
    }

    let detected_engine = detect_engine(&root_content);
    validate_engine(config, detected_engine)?;

    let started_at = Instant::now();
    let run = run_compiler(
        config,
        detected_engine,
        &root_path,
        &output_dir,
        &workspace_path,
    )
    .await?;

    if run.status != 0 {
        let log = read_compile_log(&workspace_path, &output_dir, &root_path)
            .await
            .unwrap_or(run.log);
        log_backend_compiler_used(
            run.compiler,
            run.engine,
            false,
            started_at.elapsed().as_millis(),
        );
        return Err(CompileError::CompilerFailed {
            status: run.status,
            log,
            compiler: run.compiler,
            engine: run.engine,
        });
    }

    let stem = root_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("moss-output");
    let pdf_path = output_dir.join(format!("{stem}.pdf"));
    let pdf = fs::read(pdf_path).await?;
    let title = request
        .project_title
        .as_deref()
        .map(safe_download_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "moss-output".to_string());
    let log = format!(
        "Recompiled with Moss {} compiler in {} ms.",
        run.engine.as_log_label(),
        started_at.elapsed().as_millis()
    );
    log_backend_compiler_used(
        run.compiler,
        run.engine,
        true,
        started_at.elapsed().as_millis(),
    );

    let synctex_path = find_synctex_path(&workspace_path, &output_dir, &root_path).await;
    let synctex_bytes = match &synctex_path {
        Some(path) => Some(Bytes::from(fs::read(path).await?)),
        None => None,
    };

    Ok(CompileOutput {
        pdf: Bytes::from(pdf),
        log,
        filename: format!("{title}.pdf"),
        compiler: run.compiler,
        engine: run.engine,
        duration_ms: started_at.elapsed().as_millis(),
        diagnostics: parse_compile_diagnostics(&run.log),
        synctex_bytes,
        workspace_path,
        source_paths,
    })
}

fn detect_engine(root_content: &str) -> CompilerEngine {
    if root_content.contains("% !TEX program = xelatex")
        || root_content.contains("% !TeX program = xelatex")
        || root_content.contains("% !tex program = xelatex")
        || root_content.contains("\\usepackage{fontspec}")
    {
        return CompilerEngine::XeLaTeX;
    }
    if root_content.contains("% !TEX program = lualatex")
        || root_content.contains("% !TeX program = lualatex")
        || root_content.contains("% !tex program = lualatex")
    {
        return CompilerEngine::LuaLaTeX;
    }
    CompilerEngine::PdfLaTeX
}

fn log_backend_compiler_used(
    compiler: CompilerName,
    engine: CompilerEngine,
    ok: bool,
    duration_ms: u128,
) {
    const ORANGE: &str = "\x1b[38;5;208m";
    const RESET: &str = "\x1b[0m";
    let status = if ok { "ok" } else { "failed" };
    let compiler_label = compiler.as_log_label();
    let engine_label = engine.as_log_label();

    println!(
        "{ORANGE}Moss backend compiler used: {compiler_label} / {engine_label} ({status}) in {duration_ms}ms{RESET}"
    );
    info!(
        compiler = compiler_label,
        engine = engine_label,
        ok,
        duration_ms,
        "Moss backend compiler used"
    );
}

fn validate_engine(config: &Config, engine: CompilerEngine) -> Result<(), CompileError> {
    match engine {
        CompilerEngine::XeLaTeX if !config.enable_xelatex => Err(CompileError::UnsupportedEngine {
            engine: "XeLaTeX",
            detected: engine,
        }),
        CompilerEngine::LuaLaTeX if !config.enable_lualatex => {
            Err(CompileError::UnsupportedEngine {
                engine: "LuaLaTeX",
                detected: engine,
            })
        }
        _ => Ok(()),
    }
}

async fn write_project_file(
    workspace: &Path,
    relative_path: &Path,
    file: &ProjectFilePayload,
) -> Result<(), CompileError> {
    let target = workspace.join(relative_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).await?;
    }

    let content = if let Some(text) = &file.content_text {
        Bytes::copy_from_slice(text.as_bytes())
    } else if let Some(encoded) = &file.content_base64 {
        BASE64
            .decode(encoded)
            .map(Bytes::from)
            .map_err(|source| CompileError::InvalidBase64 {
                path: file.path.clone(),
                source,
            })?
    } else {
        return Err(CompileError::MissingContent(file.path.clone()));
    };

    fs::write(target, content).await?;
    Ok(())
}

async fn run_compiler(
    config: &Config,
    detected_engine: CompilerEngine,
    root_path: &Path,
    output_dir: &Path,
    cwd: &Path,
) -> Result<CompilerRun, CompileError> {
    match config.compiler_mode {
        CompilerMode::Tectonic => run_tectonic(config, root_path, output_dir, cwd).await,
        CompilerMode::Latexmk => {
            run_latexmk(config, detected_engine, root_path, output_dir, cwd).await
        }
        CompilerMode::Auto => {
            match run_latexmk(config, detected_engine, root_path, output_dir, cwd).await {
                Ok(run) => Ok(run),
                Err(CompileError::MissingCompiler { .. })
                    if detected_engine == CompilerEngine::PdfLaTeX =>
                {
                    run_tectonic(config, root_path, output_dir, cwd).await
                }
                Err(error) => Err(error),
            }
        }
    }
}

async fn run_latexmk(
    config: &Config,
    engine: CompilerEngine,
    root_path: &Path,
    _output_dir: &Path,
    cwd: &Path,
) -> Result<CompilerRun, CompileError> {
    let engine_arg = match engine {
        CompilerEngine::PdfLaTeX => "-pdf",
        CompilerEngine::XeLaTeX => "-xelatex",
        CompilerEngine::LuaLaTeX => "-lualatex",
        CompilerEngine::Tectonic => "-pdf",
    };

    let mut command = Command::new(&config.latexmk_bin);
    apply_compiler_environment(&mut command, config);
    let child = command
        .arg(engine_arg)
        .arg("-interaction=nonstopmode")
        .arg("-file-line-error")
        .arg("-synctex=1")
        .arg("-outdir=out")
        .arg(root_path)
        .current_dir(cwd)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|source| missing_compiler("latexmk", &config.latexmk_bin, Some(engine), source))?;

    wait_for_compiler(child, config.compile_timeout, CompilerName::Latexmk, engine).await
}

async fn run_tectonic(
    config: &Config,
    root_path: &Path,
    output_dir: &Path,
    cwd: &Path,
) -> Result<CompilerRun, CompileError> {
    let mut command = Command::new(&config.tectonic_bin);
    apply_compiler_environment(&mut command, config);
    let child = command
        .arg("--keep-logs")
        .arg("--synctex")
        .arg("--outdir")
        .arg(output_dir)
        .arg(root_path)
        .current_dir(cwd)
        .env("TECTONIC_CACHE_DIR", &config.tectonic_cache_dir)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|source| {
            missing_compiler(
                "tectonic",
                &config.tectonic_bin,
                Some(CompilerEngine::Tectonic),
                source,
            )
        })?;

    wait_for_compiler(
        child,
        config.compile_timeout,
        CompilerName::Tectonic,
        CompilerEngine::Tectonic,
    )
    .await
}

fn apply_compiler_environment(command: &mut Command, config: &Config) {
    if let Some(path) = compiler_process_path(config) {
        command.env("PATH", path);
    }
}

fn compiler_process_path(config: &Config) -> Option<OsString> {
    if config.compiler_extra_path.is_empty() {
        return None;
    }

    let existing_path = env::var_os("PATH").unwrap_or_default();
    let paths = config
        .compiler_extra_path
        .iter()
        .cloned()
        .chain(env::split_paths(&existing_path));

    env::join_paths(paths).ok()
}

fn missing_compiler(
    compiler: &'static str,
    bin: &str,
    engine: Option<CompilerEngine>,
    source: io::Error,
) -> CompileError {
    if source.kind() == io::ErrorKind::NotFound {
        CompileError::MissingCompiler {
            compiler,
            bin: bin.to_string(),
            engine,
            source,
        }
    } else {
        CompileError::Io(source)
    }
}

async fn wait_for_compiler(
    child: tokio::process::Child,
    compile_timeout: Duration,
    compiler: CompilerName,
    engine: CompilerEngine,
) -> Result<CompilerRun, CompileError> {
    let child_output = timeout(compile_timeout, child.wait_with_output()).await;
    let output = match child_output {
        Ok(output) => output?,
        Err(_) => return Err(CompileError::Timeout(compile_timeout.as_secs())),
    };

    let status = output.status.code().unwrap_or(1);
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    Ok(CompilerRun {
        status,
        log,
        compiler,
        engine,
    })
}

async fn read_compile_log(
    workspace: &Path,
    output_dir: &Path,
    root_path: &Path,
) -> Result<String, std::io::Error> {
    let stem = root_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("main");
    let log_name = format!("{stem}.log");

    for candidate in [output_dir.join(&log_name), workspace.join(log_name)] {
        if let Ok(log) = fs::read_to_string(candidate).await {
            return Ok(log);
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "compiler log not found",
    ))
}

async fn find_synctex_path(
    workspace: &Path,
    output_dir: &Path,
    root_path: &Path,
) -> Option<PathBuf> {
    let stem = root_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("main");
    let synctex_name = format!("{stem}.synctex.gz");

    for candidate in [output_dir.join(&synctex_name), workspace.join(synctex_name)] {
        if fs::metadata(&candidate).await.is_ok() {
            return Some(candidate);
        }
    }

    None
}

async fn success_response(
    state: &AppState,
    output: CompileOutput,
) -> Result<Response, CompileError> {
    let compile_id = Uuid::new_v4().to_string();
    let artifact_dir = state.config.artifact_dir.join(&compile_id);
    fs::create_dir_all(&artifact_dir).await?;

    let pdf_path = artifact_dir.join("output.pdf");
    fs::write(&pdf_path, &output.pdf).await?;

    let synctex_path = if let Some(bytes) = &output.synctex_bytes {
        let target = artifact_dir.join("output.synctex.gz");
        fs::write(&target, bytes).await?;
        Some(target)
    } else {
        None
    };

    {
        let mut guard = state.artifacts.lock().expect("artifact store poisoned");
        guard.insert(
            compile_id.clone(),
            CompileArtifact {
                created_at: SystemTime::now(),
                pdf_path,
                synctex_path: synctex_path.clone(),
                original_workspace: output.workspace_path,
                source_paths: output.source_paths,
            },
        );
    }

    let body = CompileSuccessResponse {
        ok: true,
        compile_id,
        compiler: output.compiler,
        engine: output.engine,
        duration_ms: output.duration_ms,
        filename: output.filename,
        pdf_base64: BASE64.encode(&output.pdf),
        log: output.log,
        diagnostics: output.diagnostics,
        synctex_available: synctex_path.is_some(),
    };

    Ok((StatusCode::OK, Json(body)).into_response())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SynctexLocationResponse {
    ok: bool,
    file_path: String,
    line: u32,
    column: Option<u32>,
}

async fn run_synctex_reverse(
    config: &Config,
    artifact: &CompileArtifact,
    request: &SynctexReverseRequest,
) -> Result<SynctexLocationResponse, CompileError> {
    let output_arg = format!(
        "{}:{}:{}:{}",
        request.page,
        request.x.round(),
        request.y.round(),
        artifact.pdf_path.to_string_lossy()
    );

    let child = Command::new(&config.synctex_bin)
        .arg("edit")
        .arg("-o")
        .arg(output_arg)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|source| missing_compiler("synctex", &config.synctex_bin, None, source))?;

    let run = wait_for_compiler(
        child,
        Duration::from_secs(10),
        CompilerName::Latexmk,
        CompilerEngine::PdfLaTeX,
    )
    .await?;

    if run.status != 0 {
        return Err(CompileError::CompilerFailed {
            status: run.status,
            log: run.log,
            compiler: CompilerName::Latexmk,
            engine: CompilerEngine::PdfLaTeX,
        });
    }

    let input = parse_synctex_field(&run.log, "Input");
    let line = parse_synctex_number(&run.log, "Line").unwrap_or(1);
    let column = parse_synctex_number(&run.log, "Column");

    let Some(input_path) = input else {
        return Err(CompileError::CompilerFailed {
            status: 1,
            log: run.log,
            compiler: CompilerName::Latexmk,
            engine: CompilerEngine::PdfLaTeX,
        });
    };

    Ok(SynctexLocationResponse {
        ok: true,
        file_path: map_synctex_input_to_project_path(&input_path, artifact),
        line,
        column,
    })
}

fn parse_synctex_field(log: &str, field: &str) -> Option<PathBuf> {
    log.lines().find_map(|line| {
        line.strip_prefix(&format!("{field}:"))
            .map(|value| PathBuf::from(value.trim()))
    })
}

fn parse_synctex_number(log: &str, field: &str) -> Option<u32> {
    log.lines()
        .find_map(|line| line.strip_prefix(&format!("{field}:")))
        .and_then(|value| value.trim().parse().ok())
}

fn map_synctex_input_to_project_path(input_path: &Path, artifact: &CompileArtifact) -> String {
    if let Ok(relative) = input_path.strip_prefix(&artifact.original_workspace) {
        return path_to_string(relative);
    }

    let normalized_input = input_path.to_string_lossy().replace('\\', "/");
    artifact
        .source_paths
        .iter()
        .find(|source_path| normalized_input.ends_with(source_path.as_str()))
        .cloned()
        .unwrap_or(normalized_input)
}

async fn cleanup_expired_artifacts(state: &AppState) {
    let expired = {
        let mut guard = state.artifacts.lock().expect("artifact store poisoned");
        let now = SystemTime::now();
        let expired: Vec<_> = guard
            .iter()
            .filter_map(|(compile_id, artifact)| {
                now.duration_since(artifact.created_at)
                    .ok()
                    .filter(|age| *age > state.config.artifact_ttl)
                    .map(|_| compile_id.clone())
            })
            .collect();

        for compile_id in &expired {
            guard.remove(compile_id);
        }

        expired
    };

    for compile_id in expired {
        let _ = fs::remove_dir_all(state.config.artifact_dir.join(compile_id)).await;
    }
}

fn parse_compile_diagnostics(log: &str) -> Vec<CompileDiagnostic> {
    let mut diagnostics = Vec::new();
    let mut seen = std::collections::HashSet::new();

    push_regex_diagnostics(
        log,
        &mut diagnostics,
        &mut seen,
        r"(?m)^(.+?):(\d+):\s*(.+)$",
        "error",
    );
    push_latex_warning_diagnostics(log, &mut diagnostics, &mut seen);
    push_missing_file_diagnostics(log, &mut diagnostics, &mut seen);
    push_undefined_reference_diagnostics(log, &mut diagnostics, &mut seen);
    push_font_warning_diagnostics(log, &mut diagnostics, &mut seen);

    diagnostics
}

fn push_regex_diagnostics(
    log: &str,
    diagnostics: &mut Vec<CompileDiagnostic>,
    seen: &mut std::collections::HashSet<String>,
    pattern: &str,
    category: &str,
) {
    let regex = Regex::new(pattern).expect("valid diagnostic regex");
    for captures in regex.captures_iter(log) {
        let file_path = captures
            .get(1)
            .map(|value| normalize_log_path(value.as_str()));
        let line = captures
            .get(2)
            .and_then(|value| value.as_str().parse().ok());
        let message = captures
            .get(3)
            .map(|value| value.as_str().trim().to_string())
            .unwrap_or_else(|| "LaTeX error".to_string());
        push_diagnostic(
            diagnostics,
            seen,
            CompileDiagnostic {
                severity: DiagnosticSeverity::Error,
                title: "LaTeX error".to_string(),
                message,
                file_path,
                line,
                column: None,
                excerpt: None,
                category: category.to_string(),
            },
        );
    }
}

fn push_latex_warning_diagnostics(
    log: &str,
    diagnostics: &mut Vec<CompileDiagnostic>,
    seen: &mut std::collections::HashSet<String>,
) {
    let regex =
        Regex::new(r"LaTeX Warning:\s*([^\n]+?) on input line (\d+)").expect("valid warning regex");
    for captures in regex.captures_iter(log) {
        push_diagnostic(
            diagnostics,
            seen,
            CompileDiagnostic {
                severity: DiagnosticSeverity::Warning,
                title: "LaTeX warning".to_string(),
                message: captures[1].trim().to_string(),
                file_path: None,
                line: captures[2].parse().ok(),
                column: None,
                excerpt: None,
                category: "warning".to_string(),
            },
        );
    }
}

fn push_missing_file_diagnostics(
    log: &str,
    diagnostics: &mut Vec<CompileDiagnostic>,
    seen: &mut std::collections::HashSet<String>,
) {
    let regex =
        Regex::new(r"(?:LaTeX Error: )?File [`']([^`']+)[`'] not found(?: on input line (\d+))?")
            .expect("valid missing file regex");
    for captures in regex.captures_iter(log) {
        let missing = captures[1].to_string();
        push_diagnostic(
            diagnostics,
            seen,
            CompileDiagnostic {
                severity: DiagnosticSeverity::Error,
                title: format!("File '{missing}' not found"),
                message: "Upload the file into the project tree or correct the relative path."
                    .to_string(),
                file_path: None,
                line: captures
                    .get(2)
                    .and_then(|value| value.as_str().parse().ok())
                    .or_else(|| line_near(log, captures.get(0).map_or(0, |value| value.start()))),
                column: None,
                excerpt: excerpt_near(log, captures.get(0).map_or(0, |value| value.start())),
                category: "missing-file".to_string(),
            },
        );
    }
}

fn push_undefined_reference_diagnostics(
    log: &str,
    diagnostics: &mut Vec<CompileDiagnostic>,
    seen: &mut std::collections::HashSet<String>,
) {
    let citation =
        Regex::new(r"LaTeX Warning: Citation [`']([^`']+)[`'].*?undefined on input line (\d+)")
            .expect("valid citation regex");
    for captures in citation.captures_iter(log) {
        push_diagnostic(
            diagnostics,
            seen,
            CompileDiagnostic {
                severity: DiagnosticSeverity::Warning,
                title: format!("Citation '{}' is undefined", &captures[1]),
                message: "Add this key to a .bib file or fix the cite key.".to_string(),
                file_path: None,
                line: captures[2].parse().ok(),
                column: None,
                excerpt: None,
                category: "undefined-citation".to_string(),
            },
        );
    }

    let reference =
        Regex::new(r"LaTeX Warning: Reference [`']([^`']+)[`'].*?undefined on input line (\d+)")
            .expect("valid reference regex");
    for captures in reference.captures_iter(log) {
        push_diagnostic(
            diagnostics,
            seen,
            CompileDiagnostic {
                severity: DiagnosticSeverity::Warning,
                title: format!("Reference '{}' is undefined", &captures[1]),
                message: "Add the matching label or compile again after labels are generated."
                    .to_string(),
                file_path: None,
                line: captures[2].parse().ok(),
                column: None,
                excerpt: None,
                category: "undefined-reference".to_string(),
            },
        );
    }
}

fn push_font_warning_diagnostics(
    log: &str,
    diagnostics: &mut Vec<CompileDiagnostic>,
    seen: &mut std::collections::HashSet<String>,
) {
    let regex = Regex::new(r"LaTeX Font Warning:\s*([^\n]+)").expect("valid font warning regex");
    for captures in regex.captures_iter(log) {
        push_diagnostic(
            diagnostics,
            seen,
            CompileDiagnostic {
                severity: DiagnosticSeverity::Info,
                title: "Font warning".to_string(),
                message: captures[1].trim().to_string(),
                file_path: None,
                line: line_near(log, captures.get(0).map_or(0, |value| value.start())),
                column: None,
                excerpt: None,
                category: "font-warning".to_string(),
            },
        );
    }
}

fn push_diagnostic(
    diagnostics: &mut Vec<CompileDiagnostic>,
    seen: &mut std::collections::HashSet<String>,
    diagnostic: CompileDiagnostic,
) {
    let key = format!(
        "{}:{}:{}:{}",
        diagnostic.category,
        diagnostic.file_path.as_deref().unwrap_or(""),
        diagnostic.line.unwrap_or(0),
        diagnostic.message
    );
    if seen.insert(key) {
        diagnostics.push(diagnostic);
    }
}

fn line_near(log: &str, index: usize) -> Option<u32> {
    let start = index.saturating_sub(900);
    let end = (index + 900).min(log.len());
    let nearby = &log[start..end];
    Regex::new(r"(?:input line|l\.)\s*(\d+)")
        .expect("valid line regex")
        .captures(nearby)
        .and_then(|captures| captures[1].parse().ok())
}

fn excerpt_near(log: &str, index: usize) -> Option<String> {
    let end = (index + 700).min(log.len());
    let excerpt = log[index..end]
        .lines()
        .take(6)
        .collect::<Vec<_>>()
        .join("\n");
    if excerpt.trim().is_empty() {
        None
    } else {
        Some(excerpt)
    }
}

fn normalize_log_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

fn safe_project_path(input: &str) -> Result<PathBuf, CompileError> {
    let normalized = input.replace('\\', "/").trim_start_matches('/').to_string();
    if normalized.is_empty() || normalized.contains('\0') || normalized.contains(':') {
        return Err(CompileError::UnsafePath(input.to_string()));
    }

    let path = PathBuf::from(&normalized);
    if path
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        Ok(path)
    } else {
        Err(CompileError::UnsafePath(input.to_string()))
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn safe_download_name(input: &str) -> String {
    input
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn error_response(error: CompileError) -> Response {
    let status = match error {
        CompileError::EmptyFileSet
        | CompileError::UnsafePath(_)
        | CompileError::MissingRoot(_)
        | CompileError::MissingContent(_)
        | CompileError::InvalidBase64 { .. } => StatusCode::BAD_REQUEST,
        CompileError::UnsupportedEngine { .. } => StatusCode::UNPROCESSABLE_ENTITY,
        CompileError::Timeout(_) => StatusCode::REQUEST_TIMEOUT,
        CompileError::CompilerFailed { .. } => StatusCode::UNPROCESSABLE_ENTITY,
        CompileError::MissingCompiler { .. } => StatusCode::INTERNAL_SERVER_ERROR,
        CompileError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };

    let body = Json(error_body(&error));

    (status, body).into_response()
}

fn error_body(error: &CompileError) -> ErrorResponse {
    match error {
        CompileError::UnsupportedEngine { detected, .. } => ErrorResponse {
            ok: false,
            compiler: "latexmk".to_string(),
            engine: Some(*detected),
            code: ErrorCode::UnsupportedEngine,
            log: error.to_string(),
            diagnostics: vec![CompileDiagnostic {
                severity: DiagnosticSeverity::Error,
                title: "Unsupported compiler engine".to_string(),
                message: error.to_string(),
                file_path: None,
                line: Some(1),
                column: Some(1),
                excerpt: None,
                category: "unsupported-engine".to_string(),
            }],
        },
        CompileError::MissingCompiler {
            compiler, engine, ..
        } => ErrorResponse {
            ok: false,
            compiler: (*compiler).to_string(),
            engine: *engine,
            code: ErrorCode::MissingCompiler,
            log: error.to_string(),
            diagnostics: vec![CompileDiagnostic {
                severity: DiagnosticSeverity::Error,
                title: format!("{compiler} was not found"),
                message: error.to_string(),
                file_path: None,
                line: Some(1),
                column: Some(1),
                excerpt: None,
                category: "missing-compiler".to_string(),
            }],
        },
        CompileError::CompilerFailed {
            log,
            compiler,
            engine,
            ..
        } => ErrorResponse {
            ok: false,
            compiler: format!("{compiler:?}").to_ascii_lowercase(),
            engine: Some(*engine),
            code: ErrorCode::CompileFailed,
            log: log.clone(),
            diagnostics: parse_compile_diagnostics(log),
        },
        CompileError::Timeout(_) => ErrorResponse {
            ok: false,
            compiler: "moss-compiler".to_string(),
            engine: None,
            code: ErrorCode::Timeout,
            log: error.to_string(),
            diagnostics: vec![CompileDiagnostic {
                severity: DiagnosticSeverity::Error,
                title: "Compile timed out".to_string(),
                message: error.to_string(),
                file_path: None,
                line: Some(1),
                column: Some(1),
                excerpt: None,
                category: "timeout".to_string(),
            }],
        },
        CompileError::Io(_) => ErrorResponse {
            ok: false,
            compiler: "moss-compiler".to_string(),
            engine: None,
            code: ErrorCode::Io,
            log: error.to_string(),
            diagnostics: Vec::new(),
        },
        _ => ErrorResponse {
            ok: false,
            compiler: "moss-compiler".to_string(),
            engine: None,
            code: ErrorCode::BadRequest,
            log: error.to_string(),
            diagnostics: vec![CompileDiagnostic {
                severity: DiagnosticSeverity::Error,
                title: "Compile request error".to_string(),
                message: error.to_string(),
                file_path: None,
                line: Some(1),
                column: Some(1),
                excerpt: None,
                category: "bad-request".to_string(),
            }],
        },
    }
}

fn cors_layer(cors_origin: &str) -> CorsLayer {
    let methods = [Method::GET, Method::POST, Method::OPTIONS];
    let layer = CorsLayer::new()
        .allow_methods(methods)
        .allow_headers(Any)
        .expose_headers([HeaderName::from_static("x-moss-log")]);

    if cors_origin == "*" {
        layer.allow_origin(Any)
    } else if let Ok(origin) = cors_origin.parse::<HeaderValue>() {
        layer.allow_origin(origin)
    } else {
        layer.allow_origin(Any)
    }
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        error!(%error, "failed to listen for shutdown signal");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_project_path_should_accept_nested_tex_file() {
        let path = safe_project_path("sections/intro.tex").unwrap();

        assert_eq!(path, PathBuf::from("sections/intro.tex"));
    }

    #[test]
    fn safe_project_path_should_reject_parent_segments() {
        let error = safe_project_path("../secret.tex").unwrap_err();

        assert!(matches!(error, CompileError::UnsafePath(_)));
    }

    #[test]
    fn safe_download_name_should_replace_spaces() {
        let value = safe_download_name("Moss Draft 1");

        assert_eq!(value, "Moss_Draft_1");
    }

    #[test]
    fn detect_engine_should_detect_fontspec_as_xelatex() {
        let engine = detect_engine("\\documentclass{article}\n\\usepackage{fontspec}");

        assert_eq!(engine, CompilerEngine::XeLaTeX);
    }

    #[test]
    fn parse_compile_diagnostics_should_find_missing_file() {
        let diagnostics = parse_compile_diagnostics(
            "LaTeX Error: File `figures/missing.png' not found.\nl.12 \\includegraphics{figures/missing.png}",
        );

        assert!(
            diagnostics
                .iter()
                .any(|item| item.category == "missing-file")
        );
    }
}
