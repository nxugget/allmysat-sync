import { createClient } from '@supabase/supabase-js';

export function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey);
}

export const batchUpsert = async (supabase, table, rows, batchSize = 100) => {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await supabase.from(table).upsert(batch);
  }
};

export const batchInsert = async (supabase, table, rows, batchSize = 100) => {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await supabase.from(table).insert(batch);
  }
};

export const batchDelete = async (supabase, table, ids, batchSize = 100) => {
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await supabase.from(table).delete().in('id', batch);
  }
};
