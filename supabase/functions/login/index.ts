// login/index.ts – Supabase Edge Function for event login
import { serve } from "https://deno.land/std@0.152.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function constructEmail(username: string, slug: string) {
  return `${username}.${slug}@mailinator.com`;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }
  try {
    const body = await req.json();
    const { username, password, slug } = body;
    if (!username || !slug) {
      return new Response(JSON.stringify({ error: "Username and slug are required" }), { status: 400 });
    }
    const email = constructEmail(username, slug);

    // Attempt to sign in.
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: password || "no-password",
    });
    if (signInError) {
      // If invalid credentials, attempt to create a new user.
      if (signInError.message.includes("Invalid login credentials")) {
        const { data: signUpData, error: signUpError } = await supabase.auth.admin.createUser({
          email,
          password: password || "no-password",
          email_confirm: true,
        });
        if (signUpError) {
          return new Response(JSON.stringify({ error: signUpError.message }), { status: 400 });
        }
      } else {
        return new Response(JSON.stringify({ error: signInError.message }), { status: 400 });
      }
    }
    const user = signInData.session ? signInData.session.user : null;
    if (!user) {
      return new Response(JSON.stringify({ error: "User not authenticated" }), { status: 401 });
    }
    // Look up the event ID using the slug.
    const { data: eventRec } = await supabase
      .from("events")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!eventRec) {
      return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });
    }
    // Check if an event-specific profile exists.
    let { data: profileData } = await supabase
      .from("event_users")
      .select("*")
      .eq("id", user.id)
      .eq("event_id", eventRec.id)
      .maybeSingle();
    if (!profileData) {
      const { data: newProfile, error: newProfileError } = await supabase
        .from("event_users")
        .insert([{ id: user.id, event_id: eventRec.id, username }])
        .select()
        .single();
      if (newProfileError) {
        return new Response(JSON.stringify({ error: newProfileError.message }), { status: 400 });
      }
    }
    return new Response(
      JSON.stringify({ message: "Login successful", token: user.id }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
