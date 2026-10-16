// Supabase Edge Function: daily-sweep
//
// Deploy path: supabase/functions/daily-sweep/index.ts
// Deploy with: supabase functions deploy daily-sweep --no-verify-jwt
//
// Invoked once/day by pg_cron+pg_net or a Dashboard schedule (see PRD.md §11).
// Uses the service role key to read every active keyword across every user
// and bypass RLS when writing matched posts back into monitored_posts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SOCIALFETCH_API_KEY = Deno.env.get("SOCIALFETCH_API_KEY")!;
const SOCIALFETCH_BASE = "https://api.socialfetch.dev";

// Cap pagination so a single busy keyword can't blow the day's credit budget.
const MAX_PAGES_PER_KEYWORD_PER_PLATFORM = 2;

type Keyword = {
  id: string;
  user_id: string;
  keyword: string;
};

type MonitoredPostRow = {
  user_id: string;
  keyword_id: string;
  matched_keyword: string;
  platform: "twitter" | "linkedin";
  post_url: string;
  author_name: string | null;
  author_handle: string | null;
  author_avatar_url: string | null;
  body: string | null;
  posted_at: string | null;
  engagement: Record<string, unknown> | null;
  raw: unknown;
};

function yesterdayUtcDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function socialFetchGet(
  path: string,
  params: Record<string, string | undefined>,
): Promise<any> {
  const url = new URL(SOCIALFETCH_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { "x-api-key": SOCIALFETCH_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Social Fetch ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// ---- X (Twitter) search -----------------------------------------------

async function searchTwitter(keyword: string): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;
  const startDate = yesterdayUtcDate();
  const endDate = todayUtcDate();

  for (let page = 0; page < MAX_PAGES_PER_KEYWORD_PER_PLATFORM; page++) {
    const json = await socialFetchGet("/v1/twitter/search", {
      query: keyword,
      startDate,
      endDate,
      cursor,
    });
    const tweets = json?.data?.tweets ?? json?.data?.results ?? [];
    results.push(...tweets);
    const hasMore = json?.data?.page?.hasMore;
    cursor = json?.data?.page?.nextCursor;
    if (!hasMore || !cursor) break;
  }
  return results;
}

function mapTwitterResult(
  tweet: any,
  userId: string,
  keywordId: string,
  matchedKeyword: string,
): MonitoredPostRow | null {
  const url = tweet?.url ?? tweet?.permalink;
  if (!url) return null;
  return {
    user_id: userId,
    keyword_id: keywordId,
    matched_keyword: matchedKeyword,
    platform: "twitter",
    post_url: url,
    author_name: tweet?.author?.name ?? tweet?.author?.displayName ?? null,
    author_handle: tweet?.author?.handle ?? tweet?.author?.username ?? null,
    author_avatar_url: tweet?.author?.avatarUrl ?? tweet?.author?.profileImageUrl ?? null,
    body: tweet?.text ?? tweet?.body ?? null,
    posted_at: tweet?.createdAt ?? tweet?.postedAt ?? null,
    engagement: {
      likes: tweet?.likeCount ?? null,
      retweets: tweet?.retweetCount ?? null,
      replies: tweet?.replyCount ?? null,
    },
    raw: tweet,
  };
}

// ---- LinkedIn post search -----------------------------------------------

async function searchLinkedIn(keyword: string): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_KEYWORD_PER_PLATFORM; page++) {
    const json = await socialFetchGet("/v1/linkedin/posts/search", {
      query: keyword,
      datePosted: "last-day",
      cursor,
    });
    const posts = json?.data?.posts ?? json?.data?.results ?? [];
    results.push(...posts);
    const hasMore = json?.data?.page?.hasMore;
    cursor = json?.data?.page?.nextCursor;
    if (!hasMore || !cursor) break;
  }
  return results;
}

function mapLinkedInResult(
  post: any,
  userId: string,
  keywordId: string,
  matchedKeyword: string,
): MonitoredPostRow | null {
  const url = post?.url ?? post?.permalink;
  if (!url) return null;
  return {
    user_id: userId,
    keyword_id: keywordId,
    matched_keyword: matchedKeyword,
    platform: "linkedin",
    post_url: url,
    author_name: post?.author?.name ?? null,
    author_handle: post?.author?.headline ?? post?.author?.vanityName ?? null,
    author_avatar_url: post?.author?.avatarUrl ?? post?.author?.profilePictureUrl ?? null,
    body: post?.text ?? post?.body ?? post?.commentary ?? null,
    posted_at: post?.postedAt ?? post?.createdAt ?? null,
    engagement: {
      likes: post?.likeCount ?? post?.reactionCount ?? null,
      comments: post?.commentCount ?? null,
      reposts: post?.repostCount ?? null,
    },
    raw: post,
  };
}

// ---- Main handler -----------------------------------------------------

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: runRow, error: runInsertError } = await supabase
    .from("sweep_runs")
    .insert({})
    .select()
    .single();
  if (runInsertError) {
    console.error("Failed to create sweep_runs row", runInsertError);
  }
  const runId = runRow?.id;

  const errors: Array<{ userId: string; keyword: string; platform: string; message: string }> = [];
  let usersProcessed = 0;
  let postsInserted = 0;

  const { data: keywords, error: keywordsError } = await supabase
    .from("keywords")
    .select("id, user_id, keyword")
    .eq("is_active", true);

  if (keywordsError) {
    console.error("Failed to load keywords", keywordsError);
    return new Response(JSON.stringify({ ok: false, error: keywordsError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const byUser = new Map<string, Keyword[]>();
  for (const kw of (keywords ?? []) as Keyword[]) {
    const list = byUser.get(kw.user_id) ?? [];
    list.push(kw);
    byUser.set(kw.user_id, list);
  }

  for (const [userId, userKeywords] of byUser.entries()) {
    usersProcessed++;
    const rowsToUpsert: MonitoredPostRow[] = [];

    for (const kw of userKeywords) {
      try {
        const tweets = await searchTwitter(kw.keyword);
        for (const t of tweets) {
          const row = mapTwitterResult(t, userId, kw.id, kw.keyword);
          if (row) rowsToUpsert.push(row);
        }
      } catch (e) {
        errors.push({ userId, keyword: kw.keyword, platform: "twitter", message: String(e) });
      }

      try {
        const posts = await searchLinkedIn(kw.keyword);
        for (const p of posts) {
          const row = mapLinkedInResult(p, userId, kw.id, kw.keyword);
          if (row) rowsToUpsert.push(row);
        }
      } catch (e) {
        errors.push({ userId, keyword: kw.keyword, platform: "linkedin", message: String(e) });
      }
    }

    if (rowsToUpsert.length > 0) {
      const { error: upsertError, count } = await supabase
        .from("monitored_posts")
        .upsert(rowsToUpsert, { onConflict: "user_id,post_url", ignoreDuplicates: true, count: "exact" });
      if (upsertError) {
        errors.push({ userId, keyword: "*", platform: "*", message: upsertError.message });
      } else {
        postsInserted += count ?? rowsToUpsert.length;
      }
    }
  }

  if (runId) {
    await supabase
      .from("sweep_runs")
      .update({
        finished_at: new Date().toISOString(),
        users_processed: usersProcessed,
        posts_inserted: postsInserted,
        errors,
      })
      .eq("id", runId);
  }

  return new Response(
    JSON.stringify({ ok: true, usersProcessed, postsInserted, errorCount: errors.length }),
    { headers: { "Content-Type": "application/json" } },
  );
});
