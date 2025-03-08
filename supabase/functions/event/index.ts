// event/index.ts – Supabase Edge Function to get event details
import { serve } from "https://deno.land/std@0.152.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

serve(async (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }
  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug");
    if (!slug) {
      return new Response(JSON.stringify({ error: "Slug is required" }), { status: 400 });
    }
    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .select("*, event_items(*)")
      .eq("slug", slug)
      .single();
    if (eventError || !eventData) {
      return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });
    }
    const { data: commitments } = await supabase
      .from("commitments")
      .select("*")
      .eq("event_id", eventData.id);
    const { data: usersData } = await supabase
      .from("event_users")
      .select("id, username")
      .eq("event_id", eventData.id);
    return new Response(
      JSON.stringify({ event: eventData, commitments, users: usersData }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
