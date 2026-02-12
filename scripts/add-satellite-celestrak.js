import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('❌ Missing environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Parse TLE
function parseTLEFile(tleText) {
  const lines = tleText.trim().split('\n');
  const satellites = [];
  
  for (let i = 0; i < lines.length; i += 3) {
    if (i + 2 < lines.length) {
      const rawName = lines[i].trim();
      const line1 = lines[i + 1].trim();
      const line2 = lines[i + 2].trim();
      const noradId = parseInt(line1.substring(2, 7));
      
      // Parse nom et alternate
      let name = rawName;
      let alternateName = null;
      
      const match = rawName.match(/^(.+?)\s*\((.+?)\)$/);
      if (match) {
        name = match[1].trim();
        alternateName = match[2].trim();
      }
      
      if (!isNaN(noradId) && name && line1 && line2) {
        satellites.push({ 
          noradId, 
          name,
          alternateName,
          tle_line1: line1,
          tle_line2: line2
        });
      }
    }
  }
  
  return satellites;
}

// Upsert satellite
async function upsertSatellite(sat, mainCategory, subCategory) {
  try {
    const { data: existing } = await supabase
      .from('satellites')
      .select('id, norad_id, name')
      .eq('norad_id', sat.noradId)
      .single();

    if (existing) {
      return existing;
    }

    const { data, error } = await supabase
      .from('satellites')
      .insert({
        norad_id: sat.noradId,
        name: sat.name,
        alternate_names: sat.alternateName ? [sat.alternateName] : null,
        main_category: mainCategory,
        subcategory: subCategory,
        status: 'Unknown'
      })
      .select()
      .single();

    if (error) throw error;
    return data;

  } catch (error) {
    console.error(`❌ Error: ${sat.name}`, error.message);
    return null;
  }
}

// Upsert TLE
async function upsertTLE(satelliteId, sat) {
  try {
    const { data: existing } = await supabase
      .from('tle')
      .select('id')
      .eq('satellite_id', satelliteId)
      .single();

    const tleData = {
      satellite_id: satelliteId,
      tle_line1: sat.tle_line1,
      tle_line2: sat.tle_line2,
      source: 'celestrak',
    };

    if (existing) {
      const { error } = await supabase
        .from('tle')
        .update(tleData)
        .eq('satellite_id', satelliteId);
      
      if (error) {
        console.error(`❌ TLE UPDATE ERROR:`, error);
        throw error;
      }
      return 'updated';
    } else {
      const { error } = await supabase
        .from('tle')
        .insert(tleData);
      
      if (error) {
        console.error(`❌ TLE INSERT ERROR:`, error);
        throw error;
      }
      return 'inserted';
    }

  } catch (error) {
    console.error(`❌ TLE error satellite_id=${satelliteId}:`, error);
    return 'error';
  }
}

// Main
async function main() {
  const url = process.argv[2];
  const mainCategory = process.argv[3];
  const subCategory = process.argv[4] || null;

  if (!url) {
    console.error('❌ Usage: node import-tle.js <URL> <MAIN_CATEGORY> [SUB_CATEGORY]');
    console.error('Example: node import-tle.js "https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=tle" "Weather" "NOAA"');
    process.exit(1);
  }

  console.log(`\n🛰️  Importing from: ${url}`);
  console.log(`📁 Category: ${mainCategory}${subCategory ? ` / ${subCategory}` : ''}\n`);

  try {
    // Fetch TLE
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`❌ Failed to fetch: ${response.status}`);
      process.exit(1);
    }

    const tleText = await response.text();
    const satellites = parseTLEFile(tleText);

    console.log(`📡 Found ${satellites.length} satellites\n`);

    let inserted = 0;
    let updated = 0;
    let tleInserted = 0;
    let tleUpdated = 0;
    let errors = 0;

    for (const sat of satellites) {
      // Upsert satellite
      const satellite = await upsertSatellite(sat, mainCategory, subCategory);
      
      if (satellite && satellite.id) {
        console.log(`✅ ${sat.name} [${sat.noradId}]`);
        inserted++;

        // Upsert TLE
        const tleResult = await upsertTLE(satellite.id, sat);
        
        if (tleResult === 'inserted') tleInserted++;
        if (tleResult === 'updated') tleUpdated++;
        if (tleResult === 'error') errors++;
      } else {
        errors++;
      }
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ Satellites: ${inserted} processed`);
    console.log(`📍 TLE inserted: ${tleInserted}`);
    console.log(`📍 TLE updated: ${tleUpdated}`);
    console.log(`❌ Errors: ${errors}`);
    console.log(`${'='.repeat(50)}\n`);

  } catch (error) {
    console.error('💥 Error:', error.message);
    process.exit(1);
  }
}

main();
