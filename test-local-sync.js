import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Importer la logique du handler
async function testSync() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.error('❌ Missing Supabase environment variables');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
  const startTime = new Date();

  console.log(`🧪 Testing sync locally at ${startTime.toISOString()}\n`);

  try {
    // Récupérer tous les satellites
    const { data: satellites, error: satellitesError } = await supabase
      .from('satellites')
      .select('id, norad_id, name');

    if (satellitesError) {
      throw new Error(`Failed to fetch satellites: ${satellitesError.message}`);
    }

    console.log(`📊 Found ${satellites.length} satellites to sync\n`);

    let tleUpdated = 0;
    let tleUnchanged = 0;
    let transmittersAdded = 0;
    let transmittersUpdated = 0;
    let transmittersRemoved = 0;
    const syncErrors = [];

    // Limite pour test : seulement les 5 premiers satellites
    const testSatellites = satellites.slice(0, 5);
    console.log(`🔬 Testing with first ${testSatellites.length} satellites\n`);

    for (const satellite of testSatellites) {
      try {
        const { id: satelliteId, norad_id: noradId, name } = satellite;

        if (!noradId) {
          console.log(`⏭️  Skipping ${name} - no NORAD ID`);
          continue;
        }

        console.log(`\n🛰️  Processing: ${name} (NORAD: ${noradId})`);

        // ========== TLE ==========
        try {
          const tleFetchUrl = `https://celestrak.com/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=tle`;
          
          const tleResponse = await fetch(tleFetchUrl);
          if (!tleResponse.ok) {
            throw new Error(`CelesTrak HTTP ${tleResponse.status}`);
          }

          const tleText = await tleResponse.text();
          const tleLines = tleText.trim().split('\n');

          if (tleLines.length >= 2) {
            let tleLine1, tleLine2;

            if (tleLines.length === 3) {
              tleLine1 = tleLines[1].trim();
              tleLine2 = tleLines[2].trim();
            } else {
              tleLine1 = tleLines[0].trim();
              tleLine2 = tleLines[1].trim();
            }

            if (tleLine1 && tleLine2) {
              const { data: existingTLE } = await supabase
                .from('tle')
                .select('tle_line1, tle_line2')
                .eq('satellite_id', satelliteId)
                .single();

              const tleChanged = !existingTLE || 
                existingTLE.tle_line1 !== tleLine1 || 
                existingTLE.tle_line2 !== tleLine2;

              if (tleChanged) {
                const yearStr = tleLine1.substring(18, 20);
                const dayStr = tleLine1.substring(20, 32);
                const epoch = `20${yearStr}-${dayStr}`;

                const { error: tleError } = await supabase
                  .from('tle')
                  .upsert(
                    {
                      satellite_id: satelliteId,
                      tle_line1: tleLine1,
                      tle_line2: tleLine2,
                      epoch: epoch,
                      source: 'celestrak',
                    },
                    { onConflict: 'satellite_id' }
                  );

                if (tleError) throw new Error(`TLE upsert failed: ${tleError.message}`);

                tleUpdated++;
                console.log(`   ✅ TLE updated`);
              } else {
                tleUnchanged++;
                console.log(`   ⏭️  TLE unchanged`);
              }
            }
          }
        } catch (tleErr) {
          console.log(`   ❌ TLE error: ${tleErr.message}`);
          syncErrors.push(`TLE error for ${name}: ${tleErr.message}`);
        }

        // ========== TRANSMITTERS ==========
        try {
          const transmitterUrl = `https://db.satnogs.org/api/transmitters/?satellite__norad_cat_id=${noradId}`;
          
          const transmitterResponse = await fetch(transmitterUrl);
          if (!transmitterResponse.ok) {
            throw new Error(`SatNOGS HTTP ${transmitterResponse.status}`);
          }

          const transmitterData = await transmitterResponse.json();
          const apiTransmitters = Array.isArray(transmitterData) ? transmitterData : transmitterData.results || [];

          const { data: existingTransmitters } = await supabase
            .from('transmitters')
            .select('id, description, mode, alive, uplink_low, uplink_high, downlink_low, downlink_high')
            .eq('satellite_id', satelliteId);

          const existingMap = new Map(
            (existingTransmitters || []).map(tx => [tx.description, tx])
          );

          const apiMap = new Map(
            apiTransmitters.map(tx => [tx.description || '', tx])
          );

          // Ajouter nouveaux
          const toAdd = apiTransmitters.filter(tx => !existingMap.has(tx.description || ''));
          
          if (toAdd.length > 0) {
            const newTransmitters = toAdd.map(tx => ({
              satellite_id: satelliteId,
              description: tx.description || '',
              mode: tx.mode || null,
              alive: tx.alive !== false,
              uplink_low: tx.uplink_low || null,
              uplink_high: tx.uplink_high || null,
              downlink_low: tx.downlink_low || null,
              downlink_high: tx.downlink_high || null,
            }));

            const { error: insertError } = await supabase
              .from('transmitters')
              .insert(newTransmitters);

            if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

            transmittersAdded += toAdd.length;
            console.log(`   ➕ Added ${toAdd.length} transmitters`);
          }

          // Mettre à jour existants
          let updated = 0;
          for (const apiTx of apiTransmitters) {
            const existing = existingMap.get(apiTx.description || '');
            
            if (existing) {
              const hasChanged = 
                existing.mode !== (apiTx.mode || null) ||
                existing.alive !== (apiTx.alive !== false) ||
                existing.uplink_low !== (apiTx.uplink_low || null) ||
                existing.uplink_high !== (apiTx.uplink_high || null) ||
                existing.downlink_low !== (apiTx.downlink_low || null) ||
                existing.downlink_high !== (apiTx.downlink_high || null);

              if (hasChanged) {
                const { error: updateError } = await supabase
                  .from('transmitters')
                  .update({
                    mode: apiTx.mode || null,
                    alive: apiTx.alive !== false,
                    uplink_low: apiTx.uplink_low || null,
                    uplink_high: apiTx.uplink_high || null,
                    downlink_low: apiTx.downlink_low || null,
                    downlink_high: apiTx.downlink_high || null,
                  })
                  .eq('id', existing.id);

                if (updateError) throw new Error(`Update failed: ${updateError.message}`);
                updated++;
              }
            }
          }
          
          if (updated > 0) {
            transmittersUpdated += updated;
            console.log(`   🔄 Updated ${updated} transmitters`);
          }

          // Supprimer obsolètes
          const toRemove = (existingTransmitters || []).filter(
            tx => !apiMap.has(tx.description)
          );

          if (toRemove.length > 0) {
            const idsToRemove = toRemove.map(tx => tx.id);
            
            const { error: deleteError } = await supabase
              .from('transmitters')
              .delete()
              .in('id', idsToRemove);

            if (deleteError) throw new Error(`Delete failed: ${deleteError.message}`);

            transmittersRemoved += toRemove.length;
            console.log(`   🗑️  Removed ${toRemove.length} transmitters`);
          }

          if (toAdd.length === 0 && updated === 0 && toRemove.length === 0) {
            console.log(`   ⏭️  Transmitters unchanged`);
          }

        } catch (transmitterErr) {
          console.log(`   ❌ Transmitter error: ${transmitterErr.message}`);
          syncErrors.push(`Transmitter error for ${name}: ${transmitterErr.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (satelliteErr) {
        console.log(`   ❌ Satellite error: ${satelliteErr.message}`);
        syncErrors.push(`Error for ${satellite.name}: ${satelliteErr.message}`);
      }
    }

    const endTime = new Date();
    const duration = endTime - startTime;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`🎉 TEST SYNC COMPLETED`);
    console.log(`${'='.repeat(50)}`);
    console.log(`⏱️  Duration: ${Math.round(duration / 1000)}s`);
    console.log(`📍 TLE updated: ${tleUpdated}`);
    console.log(`📍 TLE unchanged: ${tleUnchanged}`);
    console.log(`➕ Transmitters added: ${transmittersAdded}`);
    console.log(`🔄 Transmitters updated: ${transmittersUpdated}`);
    console.log(`🗑️  Transmitters removed: ${transmittersRemoved}`);
    console.log(`❌ Errors: ${syncErrors.length}`);
    
    if (syncErrors.length > 0) {
      console.log(`\n⚠️  Error details:`);
      syncErrors.forEach(err => console.log(`   - ${err}`));
    }

  } catch (error) {
    console.error('💥 Critical error:', error.message);
    process.exit(1);
  }
}

testSync();
