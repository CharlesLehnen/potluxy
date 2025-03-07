import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// The serve() function will handle incoming HTTP requests.
serve(async (req) => {
  // Read your Supabase URL and key from environment variables.
  // (Either use your anon key or, if you need elevated privileges, your service role key.)
  const SUPABASE_URL = Deno.env.get("PROJECT_URL")!;
  const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // This key stays secret on the server

  // Create the Supabase client inside the function. This client never reaches the browser.
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Example: Fetch all rows from the "events" table.
  const { data, error } = await supabase.from("events").select("*");

  // If there’s an error, return it in the response.
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  // Return the data with the proper header.
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" }
  });
});
