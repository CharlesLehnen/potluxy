// createEvent/index.ts – Fixed Supabase Edge Function for creating an event with full slug return
import { serve } from "https://deno.land/std@0.152.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function generateSlug(eventName: string) {
  const uniqueId = Math.random().toString(36).substring(2, 10);
  return eventName.toLowerCase().replace(/\s+/g, "-") + "-" + uniqueId;
}

function constructEmail(username: string, slug: string) {
  return `${username}.${slug}@mailinator.com`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("OK", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const body = await req.json();
    const { eventName, eventDescription, eventDate, eventTime, username, password } = body;

    if (!eventName || !username) {
      return new Response(JSON.stringify({ error: "Event name and username are required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const slug = generateSlug(eventName);
    const email = constructEmail(username, slug);

    // Create auth user
    const { data: userData, error: userError } = await supabase.auth.admin.createUser({
      email,
      password: password || "no-password",
      email_confirm: true,
    });
    if (userError) {
      return new Response(JSON.stringify({ error: userError.message }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const newUser = userData.user;

    // Create event
    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .insert([{
        event_name: eventName,
        slug,
        created_by: username,
        event_description: eventDescription || null,
        event_date: eventDate || null,
        event_time: eventTime || null,
      }])
      .select("id, slug")
      .single();

    if (eventError || !eventData) {
      return new Response(JSON.stringify({ error: eventError?.message || "Could not create event" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const eventId = eventData.id;

    // Create event user profile
    const { error: profileError } = await supabase
      .from("event_users")
      .insert([{ id: newUser.id, event_id: eventId, username }]);

    if (profileError) {
      return new Response(JSON.stringify({ error: profileError.message }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    return new Response(
      JSON.stringify({
        message: "Event created successfully",
        slug: eventData.slug,
        token: newUser.id,
        eventId,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
