// addItem/index.ts – Supabase Edge Function to add an item with CORS handling
import { serve } from "https://deno.land/std@0.152.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Helper: Validate Authorization header and return user ID.
async function getUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user.id;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("OK", { status: 200, headers: corsHeaders });
  }
  
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }
  const userId = await getUserId(req);
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }
  try {
    const body = await req.json();
    const { newItemName, newItemQuantity, newItemDescription, eventSlug } = body;
    if (!newItemName || newItemQuantity <= 0) {
      return new Response(JSON.stringify({ error: "Invalid item details" }), { status: 400, headers: corsHeaders });
    }
    const { data: eventData } = await supabase
      .from("events")
      .select("id, created_by, slug")
      .eq("slug", eventSlug)
      .maybeSingle();
    if (!eventData) {
      return new Response(JSON.stringify({ error: "Event not found" }), { status: 404, headers: corsHeaders });
    }
    // Ensure the current user is the event creator.
    const { data: profile } = await supabase
      .from("event_users")
      .select("username")
      .eq("id", userId)
      .eq("event_id", eventData.id)
      .maybeSingle();
    if (!profile || profile.username !== eventData.created_by) {
      return new Response(JSON.stringify({ error: "Only the event creator can add items" }), { status: 403, headers: corsHeaders });
    }
    const insertData: any = {
      event_id: eventData.id,
      item_name: newItemName,
      quantity_required: newItemQuantity,
    };
    if (newItemDescription) {
      insertData.item_description = newItemDescription;
    }
    const { error } = await supabase
      .from("event_items")
      .insert([insertData]);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
    }
    return new Response(JSON.stringify({ message: "Item added" }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
});
