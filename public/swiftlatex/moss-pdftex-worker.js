importScripts("/swiftlatex/swiftlatexpdftex.js");

const swiftLatexHandler = self.onmessage;

self.onmessage = function mossPdftexWorkerMessage(event) {
  const data = event.data || {};
  if (data.cmd === "writecachefile") {
    try {
      const savepath = "/tex/" + data.fileid;
      FS.writeFile(savepath, new Uint8Array(data.src));
      texlive200_cache[data.cacheKey] = savepath;
      self.postMessage({ result: "ok", cmd: "writecachefile" });
    } catch (error) {
      console.error("Unable to write TeX cache file", error);
      self.postMessage({ result: "failed", cmd: "writecachefile" });
    }
    return;
  }

  if (data.cmd === "writecachefiles") {
    try {
      for (const file of data.files || []) {
        const savepath = "/tex/" + file.fileid;
        FS.writeFile(savepath, new Uint8Array(file.src));
        for (const cacheKey of file.cacheKeys || []) {
          texlive200_cache[cacheKey] = savepath;
        }
      }
      self.postMessage({ result: "ok", cmd: "writecachefiles" });
    } catch (error) {
      console.error("Unable to write TeX cache files", error);
      self.postMessage({ result: "failed", cmd: "writecachefiles" });
    }
    return;
  }

  if (data.cmd === "cleartexlookupcache") {
    try {
      texlive404_cache = {};
      self.postMessage({ result: "ok", cmd: "cleartexlookupcache" });
    } catch (error) {
      console.error("Unable to clear TeX lookup cache", error);
      self.postMessage({ result: "failed", cmd: "cleartexlookupcache" });
    }
    return;
  }

  swiftLatexHandler(event);
};
