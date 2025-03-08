// updateItem/index.ts – Supabase Edge Function to update an item
import { serve } from "https://deno.land/std@0.152.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }
  const userId = await getUserId(req);
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  try {
    const body = await req.json();
    const { itemId, newItemName, newQuantity, newDescription, eventSlug } = body;
    if (!newItemName || newQuantity <= 0) {
      return new Response(JSON.stringify({ error: "Invalid item details" }), { status: 400 });
    }
    const { data: eventData } = await supabase
      .from("events")
      .select("id, created_by, slug")
      .eq("slug", eventSlug)
      .maybeSingle();
    if (!eventData) {
      return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });
    }
    const { data: profile } = await supabase
      .from("event_users")
      .select("username")
      .eq("id", userId)
      .eq("event_id", eventData.id)
      .maybeSingle();
    if (!profile || profile.username !== eventData.created_by) {
      return new Response(JSON.stringify({ error: "Only the event creator can update items" }), { status: 403 });
    }
    // Check total commitments for the item.
    const { data: commitmentsData } = await supabase
      .from("commitments")
      .select("quantity")
      .eq("item_id", itemId);
    const totalCommitted = commitmentsData?.reduce((sum, c) => sum + c.quantity, 0) || 0;
    if (newQuantity < totalCommitted) {
      return new Response(JSON.stringify({ error: `Cannot reduce quantity below ${totalCommitted}` }), { status: 400 });
    }
    const updateData: any = { item_name: newItemName, quantity_required: newQuantity };
    if (newDescription !== undefined) {
      updateData.item_description = newDescription;
    }
    const { error } = await supabase
      .from("event_items")
      .update(updateData)
      .eq("id", itemId);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }
    return new Response(JSON.stringify({ message: "Item updated" }), { headers: { "Content-Type": "application/json" } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
