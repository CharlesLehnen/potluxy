import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

serve(async (req) => {
  // Handle CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response("OK", { status: 200, headers: corsHeaders });
  }

  // Only allow POST requests
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const { eventName, slug, username, eventDescription, eventDate, eventTime } = await req.json();
    if (!eventName || !slug || !username) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

   // Use the service role key instead of the anon key.
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "Supabase credentials not found" }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  // Create Supabase client with service role key.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);


  // Insert into your "events" table
  const { data, error } = await supabase
    .from("events")
    .insert([
      {
        event_name: eventName,
        slug,
        created_by: username,
        event_description: eventDescription,
        event_date: eventDate,
        event_time: eventTime,
      },
    ])
    .select()
    .single();

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }

    return new Response(JSON.stringify({ event: data }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Server Error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
