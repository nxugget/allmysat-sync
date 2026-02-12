import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('❌ Missing environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const BATCH_SIZE = 10; // Traiter 10 satellites en parallèle

// Fetch satellite details from SatNOGS
async function fetchSatelliteDetails(noradId) {
  try {
    const url = `https://db.satnogs.org/api/satellites/?norad_cat_id=${noradId}`;
    const response = await fetch(url);
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const results = Array.isArray(data) ? data : (data.results || []);
    
    return results.length > 0 ? results[0] : null;
    
  } catch (error) {
    return null;
  }
}

// Fetch transmitters from SatNOGS
async function fetchTransmitters(noradId) {
  try {
    const url = `https://db.satnogs.org/api/transmitters/?satellite__norad_cat_id=${noradId}`;
    const response = await fetch(url);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    const transmitters = Array.isArray(data) ? data : (data.results || []);
    
    return transmitters.filter(tx => tx.alive);
    
  } catch (error) {
    return [];
  }
}

// Update satellite with SatNOGS data
async function updateSatellite(satelliteId, noradId, details) {
  try {
    const updateData = {
      country: details.countries || null,
      status: details.status || null,
      launch_date: details.launched ? new Date(details.launched).toISOString() : null,
      website: details.website || null,
      description: details.description || null,
      image_url: `https://vivdypmwwlaxqdbatzis.supabase.co/storage/v1/object/public/satellite-images/${noradId}.png`,
    };

    if (details.names && details.names.length > 0) {
      updateData.alternate_names = details.names;
    }

    const { error } = await supabase
      .from('satellites')
      .update(updateData)
      .eq('id', satelliteId);

    if (error) throw error;
    return true;

  } catch (error) {
    return false;
  }
}

// Insert transmitters
async function insertTransmitters(satelliteId, transmitters) {
  if (transmitters.length === 0) return 0;

  try {
    const { data: existing } = await supabase
      .from('transmitters')
      .select('description')
      .eq('satellite_id', satelliteId);

    const existingDescriptions = new Set(existing?.map(t => t.description) || []);
    
    const newTransmitters = transmitters.filter(tx => 
      tx.description && !existingDescriptions.has(tx.description)
    );
    
    if (newTransmitters.length === 0) return 0;

    const transmitterData = newTransmitters.map(tx => ({
      satellite_id: satelliteId,
      description: tx.description || 'Unknown',
      mode: tx.mode || null,
      alive: tx.alive || false,
      uplink_low: tx.uplink_low || null,
      uplink_high: tx.uplink_high || null,
      downlink_low: tx.downlink_low || null,
      downlink_high: tx.downlink_high || null,
    }));

    const { error } = await supabase
      .from('transmitters')
      .insert(transmitterData);

    if (error) throw error;
    return newTransmitters.length;

  } catch (error) {
    return 0;
  }
}

// Process one satellite
async function processSatellite(sat, index, total) {
  const progress = `[${index + 1}/${total}]`;
  
  try {
    const details = await fetchSatelliteDetails(sat.norad_id);
    
    if (!details) {
      console.log(`${progress} ⚠️  ${sat.name} - Not found`);
      return { updated: false, transmitters: 0, notFound: true };
    }

    const success = await updateSatellite(sat.id, sat.norad_id, details);
    
    if (!success) {
      console.log(`${progress} ❌ ${sat.name} - Update failed`);
      return { updated: false, transmitters: 0, notFound: false };
    }

    const transmitters = await fetchTransmitters(sat.norad_id);
    const txCount = await insertTransmitters(sat.id, transmitters);
    
    if (txCount > 0) {
      console.log(`${progress} ✅ ${sat.name} (+${txCount} TX)`);
    } else {
      console.log(`${progress} ✅ ${sat.name}`);
    }
    
    return { updated: true, transmitters: txCount, notFound: false };

  } catch (error) {
    console.log(`${progress} ❌ ${sat.name}: ${error.message}`);
    return { updated: false, transmitters: 0, notFound: false };
  }
}

// Main
async function main() {
  console.log('\n🛰️  Enriching satellites from SatNOGS\n');

  try {
    const { data: satellites, error } = await supabase
      .from('satellites')
      .select('id, norad_id, name')
      .order('id');

    if (error) throw error;

    if (!satellites || satellites.length === 0) {
      console.log('❌ No satellites found');
      process.exit(0);
    }

    console.log(`📡 Found ${satellites.length} satellites`);
    console.log(`⚡ Processing ${BATCH_SIZE} at a time\n`);

    let updated = 0;
    let transmittersAdded = 0;
    let notFound = 0;

    // Process in batches
    for (let i = 0; i < satellites.length; i += BATCH_SIZE) {
      const batch = satellites.slice(i, i + BATCH_SIZE);
      
      const results = await Promise.all(
        batch.map((sat, idx) => processSatellite(sat, i + idx, satellites.length))
      );

      results.forEach(result => {
        if (result.updated) updated++;
        if (result.notFound) notFound++;
        transmittersAdded += result.transmitters;
      });

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ Satellites updated: ${updated}`);
    console.log(`📡 Transmitters added: ${transmittersAdded}`);
    console.log(`⚠️  Not found: ${notFound}`);
    console.log(`${'='.repeat(50)}\n`);

  } catch (error) {
    console.error('💥 Error:', error.message);
    process.exit(1);
  }
}

main();
