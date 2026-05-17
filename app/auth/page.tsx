"use client";

import { FormEvent, useState } from "react";
import { ArrowLeft, LogIn } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

export default function AuthPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (!supabase) {
      setMessage("Add NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local first.");
      return;
    }
    setLoading(true);
    const action =
      mode === "signin"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });
    const { error } = await action;
    setLoading(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage(mode === "signin" ? "Signed in. Go back to Moss." : "Account created. Check email confirmation if enabled.");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <section className="flex w-full max-w-sm flex-col gap-5 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowLeft data-icon="inline-start" />
          Back to Moss
        </Link>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{mode === "signin" ? "Sign in" : "Create account"}</h1>
          <p className="text-sm text-muted-foreground">Moss uses Supabase Auth and private row-level security.</p>
        </div>
        {!isSupabaseConfigured ? (
          <div className="rounded-lg border bg-muted p-3 text-sm text-muted-foreground">
            Supabase URL is set, but the anon key is missing in <code>.env.local</code>.
          </div>
        ) : null}
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <label className="flex flex-col gap-2 text-sm font-medium">
            Email
            <input
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-2 text-sm font-medium">
            Password
            <input
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={6}
            />
          </label>
          <Button type="submit" disabled={loading || !isSupabaseConfigured}>
            <LogIn data-icon="inline-start" />
            {loading ? "Working..." : mode === "signin" ? "Sign in" : "Sign up"}
          </Button>
        </form>
        <Button variant="ghost" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "Need an account?" : "Already have an account?"}
        </Button>
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </section>
    </main>
  );
}
