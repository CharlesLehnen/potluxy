import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  // Initialize Supabase client securely on the server
  const supabase = createClient(
    Deno.env.get("PROJECT_URL")!, 
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! 
  );

  const { data, error } = await supabase.from("events").select("*");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" }
  });
});
