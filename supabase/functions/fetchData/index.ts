import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  // Initialize Supabase client server-side.
  const supabase = createClient(
    Deno.env.get("PROJECT_URL")!,         // Set in your secrets
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // This key is private!
  );

  // For example, fetch events from the "events" table.
  const { data, error } = await supabase.from("events").select("*");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" }
  });
});
