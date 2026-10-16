/**
 * Echo — Edge Function client
 * ----------------------------------------------------------------------------
 * Every privileged API (SocialFetch search, OpenAI, Stripe billing) runs as a
 * Supabase Edge Function. The browser never holds a vendor API key.
 *
 * supabase.functions.invoke() automatically attaches the signed-in user's JWT,
 * which is what the functions verify server-side.
 */
import { supabase, isConfigured } from './supabase';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface InvokeOptions {
  /** Local sandbox mode (no Supabase configured) — returns this instead. */
  fallback?: () => unknown;
  timeoutMs?: number;
}

export async function invokeFunction<T = unknown>(
  name: string,
  body: Record<string, unknown>,
  options: InvokeOptions = {},
): Promise<T> {
  if (!isConfigured || !supabase) {
    if (options.fallback) return options.fallback() as T;
    throw new ApiError('This feature requires a connected Supabase project.', 503);
  }

  const controller = new AbortController();
  const timer = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;

  try {
    const { data, error } = await supabase.functions.invoke(name, {
      body,
      signal: controller.signal,
    });

    if (error) {
      // Supabase surfaces function errors as a non-2xx Error with the body text.
      const message =
        error.context instanceof Response
          ? await readErrorBody(error.context)
          : error.message;
      throw new ApiError(message || `Request to "${name}" failed.`, 500);
    }

    return data as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(`"${name}" timed out. Please try again.`, 504);
    }
    throw new ApiError((err as Error)?.message || `Request to "${name}" failed.`, 500);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Supabase packs function error details into a Response on the error object. */
async function readErrorBody(res: Response): Promise<string> {
  try {
    const body = await res.clone().json();
    return body?.error || body?.message || '';
  } catch {
    return '';
  }
}