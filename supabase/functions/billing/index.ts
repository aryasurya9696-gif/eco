// Retired. Echo is free: there is no plan, no purchase and no payment
// processor, so this function has nothing left to do.
//
// The deployed function answers 410 rather than 404 so an old client that still
// calls it gets a deliberate "gone" instead of a confusing failure.
//
// Deploy:  supabase functions deploy billing --no-verify-jwt
Deno.serve(() =>
  new Response(JSON.stringify({ ok: false, error: 'billing has been removed' }), {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
  }),
);
