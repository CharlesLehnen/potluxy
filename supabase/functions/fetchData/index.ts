import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  // ✅ Handle CORS Preflight Request (OPTIONS method)
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    const { eventName, eventDescription, eventDate, eventTime, username, password, slug, email } = await req.json();

    if (!eventName || !username || !slug) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // 🛠 Supabase Connection (Fetch Secrets from Env)
    const SUPABASE_URL = Deno.env.get("PROJECT_URL")!;
    const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // ✅ Insert the new event into the database
    const { data, error } = await supabase.from("events").insert([
      { event_name: eventName, slug, created_by: username, event_description: eventDescription, event_date: eventDate, event_time: eventTime }
    ]).select().single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // ✅ Return the successful response with CORS headers
    return new Response(JSON.stringify({ event: data }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: "Server Error" }), {
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
});
