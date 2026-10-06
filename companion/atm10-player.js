// CLIENT SCRIPT: install in kubejs/client_scripts, never server_scripts.
// Normal survival input only. No teleportation, flight, health/velocity edits or item creation.
(() => {
  const base = 'kubejs/export/mcp-player/';
  let lastError = null;
  function health(status) {
    try { JsonIO.write(base + 'health.json', { protocol: 1, bridgeVersion: 2, channel: 'player', status: status,
      observedAt: new Date().toISOString(), error: lastError }); }
    catch (e) { console.error('[ATM10 MCP] Player heartbeat: ' + e); }
  }
  health('loading');
  try {
    const Files = Java.loadClass('java.nio.file.Files');
    const Paths = Java.loadClass('java.nio.file.Paths');
    const Copy = Java.loadClass('java.nio.file.StandardCopyOption');
    const BlockPos = Java.loadClass('net.minecraft.core.BlockPos');
    const Registries = Java.loadClass('net.minecraft.core.registries.BuiltInRegistries');
    const FluidTags = Java.loadClass('net.minecraft.tags.FluidTags');
    const Hand = Java.loadClass('net.minecraft.world.InteractionHand');
    const Enemy = Java.loadClass('net.minecraft.world.entity.monster.Enemy');
    const NeutralMob = Java.loadClass('net.minecraft.world.entity.NeutralMob');
    const Mob = Java.loadClass('net.minecraft.world.entity.Mob');
    const Living = Java.loadClass('net.minecraft.world.entity.LivingEntity');
    const Player = Java.loadClass('net.minecraft.world.entity.player.Player');
    const Projectile = Java.loadClass('net.minecraft.world.entity.projectile.Projectile');
    const GLFW = Java.loadClass('org.lwjgl.glfw.GLFW');
    const KeyMapping = Java.loadClass('net.minecraft.client.KeyMapping');
    const BlockItem = Java.loadClass('net.minecraft.world.item.BlockItem');
    const BlockTags = Java.loadClass('net.minecraft.tags.BlockTags');
    const Direction = Java.loadClass('net.minecraft.core.Direction');
    const Vec3 = Java.loadClass('net.minecraft.world.phys.Vec3');
    const BlockHitResult = Java.loadClass('net.minecraft.world.phys.BlockHitResult');
    const ClipContext = Java.loadClass('net.minecraft.world.level.ClipContext');
    const ClipBlock = Java.loadClass('net.minecraft.world.level.ClipContext$Block');
    const ClipFluid = Java.loadClass('net.minecraft.world.level.ClipContext$Fluid');
    const mc = Client;
    const defaults = { autoDefend: true, autoEat: true, waterClutch: true, fleeHealth: 8, eatBelow: 16,
      threatRadius: 8, weaponSlot: null, hostileEntityIds: [] };
    let config = Object.assign({}, defaults);
    let enabled = false, session = null, playerId = null, dimension = null;
    let tickCount = 0, lastId = null, action = null, heldUse = null, clutchUntil = 0, attackUntil = 0;
    let reason = 'disabled', lastHealth = null, hurtUntil = 0;
    let nextAction = 1;
    let modKey = null, inReaction = false, emergency = false;
    const events = [], ownedKeys = {};
    const keyNames = { forward: 'keyUp', back: 'keyDown', left: 'keyLeft', right: 'keyRight', jump: 'keyJump', sneak: 'keyShift', sprint: 'keySprint', use: 'keyUse' };
    const harmful = ['minecraft:lava', 'minecraft:fire', 'minecraft:soul_fire', 'minecraft:cactus', 'minecraft:magma_block',
      'minecraft:campfire', 'minecraft:soul_campfire', 'minecraft:powder_snow', 'minecraft:sweet_berry_bush', 'minecraft:wither_rose'];
    function event(type, detail) {
      if (events.length && events[events.length - 1].type === type && events[events.length - 1].detail === detail) return;
      events.push({ tick: tickCount, observedAt: new Date().toISOString(), type: type, detail: detail });
      if (events.length > 30) events.shift();
    }
    function integer(value, fallback, min, max) {
      const n = value === undefined ? fallback : Number(value);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error('Integer outside allowed range');
      return n;
    }
    function number(value, fallback, min, max) {
      const n = value === undefined ? fallback : Number(value);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error('Number outside allowed range');
      return n;
    }
    function read(name, max) {
      const path = Paths.get(base + name);
      try {
        if (!Files.exists(path)) return null;
        if (Number(Files.size(path)) > max) throw new Error(name + ' exceeds size limit');
        return JSON.parse(String(JsonIO.readString(path)));
      } catch (e) {
        // MCP may remove a completed request between exists/size/read on another thread.
        if (String(e).includes('NoSuchFileException') || String(e).includes('ENOENT')) return null;
        throw e;
      }
    }
    function publish(value) {
      JsonIO.write(base + 'response.tmp', value);
      try { Files.move(Paths.get(base + 'response.tmp'), Paths.get(base + 'response.json'), Copy.REPLACE_EXISTING, Copy.ATOMIC_MOVE); }
      catch (e) {
        if (!String(e).includes('AtomicMoveNotSupported')) throw e;
        Files.move(Paths.get(base + 'response.tmp'), Paths.get(base + 'response.json'), Copy.REPLACE_EXISTING);
      }
    }
    function keys(values) {
      Object.keys(ownedKeys).forEach(name => {
        if (!values[name]) { mc.options[keyNames[name]].setDown(false); delete ownedKeys[name]; }
      });
      Object.keys(values).forEach(name => {
        if (values[name]) { mc.options[keyNames[name]].setDown(true); ownedKeys[name] = true; }
      });
    }
    function finishUse() {
      if (!heldUse) return;
      if (mc.player && mc.gameMode && mc.player.isUsingItem()) mc.gameMode.releaseUsingItem(mc.player);
      if (mc.player && heldUse.previousSlot !== null && mc.player.getInventory().selected === heldUse.slot)
        mc.player.getInventory().selected = heldUse.previousSlot;
      heldUse = null;
    }
    function interrupt(why) {
      if (inReaction) emergency = true;
      if (modKey) { modKey.binding.setDown(false); modKey = null; }
      if (action) { event('interrupted', action.id + ': ' + why); action = null; }
      reason = why;
    }
    function disarm(why) {
      interrupt(why);
      finishUse();
      keys({});
      enabled = false;
      session = null;
      lastHealth = null;
      event('disabled', why);
    }
    function mode() { return mc.gameMode ? String(mc.gameMode.getPlayerMode().getName()) : 'disconnected'; }
    function ready() {
      if (!mc.player || !mc.level || !mc.gameMode) throw new Error('Enter a world first');
      if (!mc.player.isAlive()) throw new Error('Player is dead');
      if (mode() !== 'survival') throw new Error('Player control requires survival mode');
      if (mc.screen !== null || mc.isPaused()) throw new Error('Close the screen/menu and unpause the world before enabling control');
      if (mc.player.isPassenger()) throw new Error('Dismount before enabling player control');
    }
    function leaseValid(id) {
      const lease = read('lease.json', 2048);
      return lease && lease.session === id && Number.isFinite(lease.expiresAt) && lease.expiresAt >= Date.now() && lease.expiresAt <= Date.now() + 6000;
    }
    function food(stack) {
      if (stack.isEmpty()) return null;
      const id = String(Registries.ITEM.getKey(stack.getItem()));
      if (['minecraft:rotten_flesh', 'minecraft:spider_eye', 'minecraft:pufferfish', 'minecraft:poisonous_potato', 'minecraft:suspicious_stew'].includes(id)) return null;
      const value = stack.getFoodProperties(mc.player);
      // Unknown effects are not a safe automatic food choice. Explicit held-item use remains available.
      return value && value.nutrition() > 0 && value.effects().isEmpty() ? value : null;
    }
    function hotbar() {
      const results = [];
      for (let i = 0; i < 9; i++) {
        const stack = mc.player.getInventory().getItem(i);
        const record = { slot: i, id: String(Registries.ITEM.getKey(stack.getItem())), count: Number(stack.getCount()) };
        try { const value = food(stack); record.foodNutrition = value ? Number(value.nutrition()) : null; }
        catch (e) { record.foodError = String(e); }
        results.push(record);
      }
      return results;
    }
    function block(x, y, z) {
      const pos = BlockPos.containing(x, y, z);
      if (!mc.level.hasChunkAt(pos)) return null;
      const state = mc.level.getBlockState(pos);
      const fluid = state.getFluidState();
      return { solid: !state.getCollisionShape(mc.level, pos).isEmpty(),
        dangerous: harmful.includes(String(Registries.BLOCK.getKey(state.getBlock()))) || fluid.is(FluidTags.LAVA), water: fluid.is(FluidTags.WATER) };
    }
    function safeDirection(dx, dz, allowWater) {
      const p = mc.player, y = Number(p.getY());
      // Check the swept path and the four corners of the player's projected footprint.
      for (const distance of [0.35, 0.75, 1.2]) {
        const x = Number(p.getX()) + dx * distance, z = Number(p.getZ()) + dz * distance;
        for (const sx of [-0.3, 0.3]) for (const sz of [-0.3, 0.3]) {
          const feet = block(x + sx, y + 0.05, z + sz), head = block(x + sx, y + 1.2, z + sz), floor = block(x + sx, y - 0.15, z + sz);
          if (!feet || !head || !floor || feet.dangerous || head.dangerous || floor.dangerous) return false;
          if (feet.solid || head.solid || (!floor.solid && !(allowWater && (feet.water || floor.water)))) return false;
        }
      }
      return true;
    }
    function heading(direction) {
      const yaw = Number(mc.player.getYRot()) * Math.PI / 180;
      const angles = { forward: 0, back: Math.PI, left: -Math.PI / 2, right: Math.PI / 2 };
      const angle = yaw + angles[direction];
      return { x: -Math.sin(angle), z: Math.cos(angle) };
    }
    function lookAt(entity) {
      const p = mc.player;
      const dx = Number(entity.getX()) - Number(p.getX()), dz = Number(entity.getZ()) - Number(p.getZ());
      const dy = Number(entity.getEyeY()) - Number(p.getEyeY());
      p.setYRot(Math.atan2(-dx, dz) * 180 / Math.PI);
      p.setXRot(-Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180 / Math.PI);
    }
    function threats() {
      const p = mc.player, results = [], radius = config.threatRadius;
      const entities = mc.level.getEntities(p, p.getBoundingBox().inflate(radius), entity => entity.isAlive());
      const it = entities.iterator();
      let visited = 0;
      while (it.hasNext() && visited++ < 256) {
        const entity = it.next();
        if (entity instanceof Player) continue; // No automatic PvP, even if configured as hostile.
        const distance = Math.sqrt(Number(p.distanceToSqr(entity)));
        if (distance > radius || !p.hasLineOfSight(entity)) continue;
        const id = String(Registries.ENTITY_TYPE.getKey(entity.getType()));
        let projectile = false;
        if (entity instanceof Projectile) {
          const owner = entity.getOwner();
          if (owner !== null && owner.getId() === p.getId()) continue;
          const v = entity.getDeltaMovement();
          const speed = v.x * v.x + v.y * v.y + v.z * v.z;
          if (speed < 0.01) continue;
          const dx = p.getX() - entity.getX(), dy = p.getY() + 0.9 - entity.getY(), dz = p.getZ() - entity.getZ();
          const t = (dx * v.x + dy * v.y + dz * v.z) / speed;
          if (t < 0 || t > 10 || Math.pow(dx - v.x * t, 2) + Math.pow(dy - v.y * t, 2) + Math.pow(dz - v.z * t, 2) > 2.25) continue;
          projectile = true;
        } else {
          if (!(entity instanceof Living)) continue;
          const hostile = entity instanceof Enemy && !(entity instanceof NeutralMob)
            || entity instanceof Mob && entity.isAggressive() || config.hostileEntityIds.includes(id);
          if (!hostile) continue;
        }
        results.push({ entity: entity, id: id, entityId: Number(entity.getId()), distance: distance, projectile: projectile, explosive: id === 'minecraft:creeper' });
      }
      return results.sort((a, b) => (a.projectile ? -100 : a.distance) - (b.projectile ? -100 : b.distance));
    }
    function retreat(threat, why) {
      const p = mc.player;
      let best = null, score = -Infinity;
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4, dx = Math.sin(angle), dz = Math.cos(angle);
        if (!safeDirection(dx, dz, true)) continue;
        let value = 0;
        if (threat) {
          const tx = p.getX() + dx * 2 - threat.entity.getX(), tz = p.getZ() + dz * 2 - threat.entity.getZ();
          value = tx * tx + tz * tz;
          if (threat.projectile) {
            const v = threat.entity.getDeltaMovement();
            value = Math.abs(dx * v.z - dz * v.x) * 100 + value;
          }
        }
        const feet = block(p.getX() + dx, p.getY(), p.getZ() + dz);
        if (p.isOnFire() && feet && feet.water) value += 1000;
        if (value > score) { score = value; best = { x: dx, z: dz }; }
      }
      interrupt(why);
      if (best) {
        p.setYRot(Math.atan2(-best.x, best.z) * 180 / Math.PI);
        keys({ forward: true, sprint: p.getFoodData().getFoodLevel() > 6 });
      } else keys({ sneak: true });
      event('reaction', best ? why : why + ': no safe route');
      return !!best;
    }
    function canAttack(entity) {
      const p = mc.player;
      return entity instanceof Living && !(entity instanceof Player) && entity.isAlive() && p.hasLineOfSight(entity)
        && Number(p.distanceToSqr(entity)) <= Math.pow(Math.min(3, Number(p.entityInteractionRange())), 2);
    }
    function attack(entity) {
      if (!canAttack(entity)) throw new Error('Target must be a visible living non-player entity within survival reach');
      if (tickCount < attackUntil || mc.player.getAttackStrengthScale(0.5) < 0.9) return false;
      lookAt(entity);
      mc.gameMode.attack(mc.player, entity);
      mc.player.swing(Hand.MAIN_HAND);
      attackUntil = tickCount + 4;
      return true;
    }
    function shield() {
      const p = mc.player;
      if (String(p.getOffhandItem().getUseAnimation()).toLowerCase() !== 'block') return false;
      if (!heldUse || heldUse.kind !== 'shield') {
        finishUse();
        mc.gameMode.useItem(p, Hand.OFF_HAND);
        heldUse = { kind: 'shield', previousSlot: null, slot: null, until: tickCount + 100 };
      }
      keys({ use: true, sneak: true });
      return true;
    }
    function eat() {
      if (mc.player.getFoodData().getFoodLevel() >= 20) return false;
      let selected = null;
      for (const item of hotbar()) if (item.foodNutrition && (!selected || item.foodNutrition > selected.foodNutrition)) selected = item;
      if (!selected) { event('unavailable', 'No suitable food in hotbar'); return false; }
      finishUse();
      const previous = Number(mc.player.getInventory().selected);
      mc.player.getInventory().selected = selected.slot;
      heldUse = { kind: 'food', previousSlot: previous, slot: selected.slot, until: tickCount + 100 };
      keys({ use: true });
      mc.gameMode.useItem(mc.player, Hand.MAIN_HAND);
      event('reaction', 'Eating from hotbar slot ' + selected.slot);
      return true;
    }
    function clutch() {
      const p = mc.player;
      if (!config.waterClutch || tickCount < clutchUntil || p.onGround() || p.isInWater() || p.getDeltaMovement().y > -0.4 || Number(p.fallDistance) < 2.5) return false;
      interrupt('falling');
      finishUse();
      keys({});
      if (mc.level.dimensionType().ultraWarm()) { event('unavailable', 'Water clutch unavailable in an ultrawarm dimension'); return true; }
      const bucket = hotbar().find(item => item.id === 'minecraft:water_bucket' && item.count > 0);
      if (!bucket) { event('unavailable', 'Falling: no water bucket in hotbar'); return true; }
      let landing = false;
      // Wait until the landing surface is inside normal block interaction reach.
      for (let depth = 0.5; depth <= 2.5; depth += 0.5) {
        const floor = block(p.getX(), p.getY() - depth, p.getZ());
        if (floor && floor.solid && !floor.dangerous) { landing = true; break; }
      }
      if (!landing) return true;
      p.getInventory().selected = bucket.slot;
      p.setXRot(90);
      mc.gameMode.useItem(p, Hand.MAIN_HAND);
      p.swing(Hand.MAIN_HAND);
      clutchUntil = tickCount + 10;
      event('reaction', 'Water-bucket clutch attempted through native item use; success is not assumed');
      return true;
    }
    function schedule(kind, data, ticks) {
      interrupt('replaced by a new command');
      finishUse();
      keys({});
      action = Object.assign({ id: nextAction++, kind: kind, until: tickCount + ticks }, data || {});
      reason = 'command';
      return { accepted: true, actionId: action.id, completesByTick: action.until, completion: 'pending', interruptible: true };
    }
    function bindings() {
      const result = [];
      for (let i = 0; i < mc.options.keyMappings.length; i++) result.push(mc.options.keyMappings[i]);
      return result;
    }
    function useBlock(args, placing) {
      const x = integer(args.x, undefined, -30000000, 30000000), y = integer(args.y, undefined, -2048, 2048), z = integer(args.z, undefined, -30000000, 30000000);
      const face = Direction.byName(String(args.face || 'up'));
      if (face === null) throw new Error('Invalid block face');
      const pos = new BlockPos(x, y, z);
      if (!mc.level.hasChunkAt(pos)) throw new Error('Support/target chunk is not loaded');
      const state = mc.level.getBlockState(pos);
      if (state.isAir()) throw new Error('A real target/support block is required');
      if (!placing && state.is(BlockTags.BEDS) && !mc.level.dimensionType().bedWorks()) throw new Error('Bed interaction refused: beds explode in this dimension');
      if (args.sleep && (!state.is(BlockTags.BEDS) || !mc.level.dimensionType().bedWorks())) throw new Error('Sleeping requires a bed in a dimension where beds work safely');
      const slot = placing ? integer(args.slot, undefined, 0, 8) : null;
      if (placing && !(mc.player.getInventory().getItem(slot).getItem() instanceof BlockItem)) throw new Error('Selected hotbar slot must contain a block item');
      const point = new Vec3(x + 0.5 + face.getStepX() * 0.5, y + 0.5 + face.getStepY() * 0.5, z + 0.5 + face.getStepZ() * 0.5);
      const eye = mc.player.getEyePosition();
      if (Number(eye.distanceToSqr(point)) > Math.pow(Math.min(4.5, Number(mc.player.blockInteractionRange())), 2)) throw new Error('Block face is outside survival reach');
      // Aim just inside the face so ray clipping reliably intersects the target block.
      const inside = new Vec3(point.x - face.getStepX() * 0.001, point.y - face.getStepY() * 0.001, point.z - face.getStepZ() * 0.001);
      const sight = mc.level.clip(new ClipContext(eye, inside, ClipBlock.OUTLINE, ClipFluid.NONE, mc.player));
      if (String(sight.getType()) !== 'BLOCK' || !sight.getBlockPos().equals(pos) || String(sight.getDirection().getName()) !== String(face.getName())) throw new Error('Requested support face is obstructed or not visible');
      interrupt(placing ? 'block placement' : 'block interaction'); finishUse(); keys({});
      if (placing) mc.player.getInventory().selected = slot;
      const dx = point.x - eye.x, dy = point.y - eye.y, dz = point.z - eye.z;
      mc.player.setYRot(Math.atan2(-dx, dz) * 180 / Math.PI);
      mc.player.setXRot(-Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180 / Math.PI);
      // Ordinary BlockItem/bed hooks enforce inventory, placement, reach and server rules.
      const result = mc.gameMode.useItemOn(mc.player, Hand.MAIN_HAND, new BlockHitResult(point, face, pos, false));
      mc.player.swing(Hand.MAIN_HAND);
      return { attempted: true, nativeResult: String(result), serverConfirmed: false, note: 'Inspect the world/player state for the authoritative outcome' };
    }
    function snapshot() {
      const p = mc.player;
      return { source: 'minecraft-client', enabled: enabled, reason: reason, tick: tickCount, mode: mode(),
        player: p ? { name: String(p.getGameProfile().getName()), uuid: String(p.getUUID()),
          dimension: String(mc.level.dimension().location()), x: Number(p.getX()), y: Number(p.getY()), z: Number(p.getZ()),
          yaw: Number(p.getYRot()), pitch: Number(p.getXRot()), health: Number(p.getHealth()), maxHealth: Number(p.getMaxHealth()),
          food: Number(p.getFoodData().getFoodLevel()), air: Number(p.getAirSupply()), onGround: Boolean(p.onGround()), fallDistance: Number(p.fallDistance),
          inWater: Boolean(p.isInWater()), inLava: Boolean(p.isInLava()), onFire: Boolean(p.isOnFire()), sleeping: Boolean(p.isSleeping()), hotbar: hotbar(), selectedSlot: Number(p.getInventory().selected) } : null,
        threats: p ? threats().map(t => ({ id: t.id, entityId: t.entityId, distance: t.distance, projectile: t.projectile })) : [],
        action: action, events: events.slice(), config: config,
        limitations: ['Local steering, not long-range pathfinding', 'Rescues require native reach and available hotbar items',
          'No automatic PvP, creative flight, teleport commands, damage cancellation or inventory creation', 'Custom mod hazards and projectile effects may not be recognized',
          'Tick reactions are best effort; game lag and network latency still apply'] };
    }
    function handle(operation, args) {
      if (operation === 'player_state') return snapshot();
      if (operation === 'player_keybinds') {
        const q = String(args.query || '').toLowerCase(), offset = integer(args.offset, 0, 0, 10000), limit = integer(args.limit, 30, 1, 100);
        const values = bindings().filter(binding => String(binding.getName()).toLowerCase().includes(q)).sort((a, b) => String(a.getName()).localeCompare(String(b.getName())));
        return { total: values.length, offset: offset, nextOffset: offset + limit < values.length ? offset + limit : null,
          results: values.slice(offset, offset + limit).map(binding => ({ name: String(binding.getName()), category: String(binding.getCategory()), down: Boolean(binding.isDown()), key: String(binding.getTranslatedKeyMessage().getString()) })),
          gunCompatibility: 'unverified; a registered binding does not prove a weapon supports this input path' };
      }
      if (operation === 'player_configure') {
        ready();
        if (typeof args.session !== 'string' || args.session.length > 64 || !leaseValid(args.session)) throw new Error('Fresh control lease required');
        if (enabled && session !== args.session) throw new Error('Another session owns the player');
        const next = Object.assign({}, defaults);
        ['autoDefend', 'autoEat', 'waterClutch'].forEach(key => {
          if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(key + ' must be boolean');
          if (args[key] !== undefined) next[key] = args[key];
        });
        next.fleeHealth = number(args.fleeHealth, 8, 2, 20);
        next.eatBelow = integer(args.eatBelow, 16, 1, 20);
        next.threatRadius = number(args.threatRadius, 8, 3, 16);
        next.weaponSlot = args.weaponSlot === undefined || args.weaponSlot === null ? null : integer(args.weaponSlot, 0, 0, 8);
        next.hostileEntityIds = args.hostileEntityIds || [];
        if (!Array.isArray(next.hostileEntityIds) || next.hostileEntityIds.length > 128 || next.hostileEntityIds.some(id => typeof id !== 'string' || id.length > 200 || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id))) throw new Error('Invalid hostile entity IDs');
        disarm('configuration updated');
        config = next; enabled = true; session = args.session;
        playerId = String(mc.player.getUUID()); dimension = String(mc.level.dimension().location());
        lastHealth = Number(mc.player.getHealth()); reason = 'watching';
        event('enabled', 'Local survival controller enabled');
        return { enabled: true, player: playerId, config: config, reactionCadence: 'each client tick; nominally 20 ticks/second, subject to lag' };
      }
      ready();
      if (!enabled || args.session !== session || !leaseValid(session)) throw new Error('Enable this player session before sending controls');
      if (emergency) throw new Error('Emergency survival reaction has priority: ' + reason);
      if (operation === 'player_interact' || operation === 'player_place') return useBlock(args, operation === 'player_place');
      if (operation === 'player_keybind') {
        const ticks = integer(args.ticks, 1, 1, 100);
        const binding = bindings().find(value => String(value.getName()) === args.name);
        if (!binding || String(args.name).startsWith('key.hotbar.') || String(args.name).startsWith('key.') && !String(args.name).slice(4).includes('.')) throw new Error('Use an exact registered mod keybinding; built-in controls have dedicated tools');
        if (binding.isUnbound() || String(binding.getKeyModifier()) !== 'NONE') throw new Error('Assign this binding an unmodified key before using it');
        if (bindings().some(other => String(other.getName()) !== String(binding.getName()) && other.getKey().equals(binding.getKey()))) throw new Error('This key is shared by multiple bindings; assign a unique key first');
        schedule('keybinding', { name: String(args.name) }, ticks);
        modKey = { binding: binding, until: tickCount + ticks };
        binding.setDown(true); KeyMapping.click(binding.getKey());
        return { accepted: true, actionId: action.id, binding: String(args.name), outcome: 'mod-specific and unverified' };
      }
      if (operation === 'player_move') {
        if (!['forward', 'back', 'left', 'right'].includes(args.direction)) throw new Error('Invalid movement direction');
        return schedule('move', { direction: args.direction, sprint: args.sprint === true, sneak: args.sneak === true }, integer(args.ticks, 20, 1, 100));
      }
      if (operation === 'player_look') {
        const yaw = number(args.yaw, undefined, -180, 180), pitch = number(args.pitch, undefined, -90, 90);
        mc.player.setYRot(yaw); mc.player.setXRot(pitch);
        return { applied: true, yaw: yaw, pitch: pitch };
      }
      if (operation === 'player_select') {
        const slot = integer(args.slot, undefined, 0, 8);
        finishUse(); mc.player.getInventory().selected = slot;
        return { selectedSlot: slot };
      }
      if (operation === 'player_action') {
        const ticks = integer(args.ticks, 20, 1, 100);
        if (args.action === 'attack') {
          const id = integer(args.entityId, undefined, 0, 2147483647);
          const entity = mc.level.getEntity(id);
          if (entity === null || !canAttack(entity)) throw new Error('Target is absent, out of reach, not visible or not a non-player mob');
          interrupt('attack command'); finishUse(); keys({});
          return { attacked: attack(entity), note: 'False means the normal attack cooldown is not ready' };
        }
        if (args.action === 'eat') {
          interrupt('eat command');
          return { started: eat() };
        }
        if (args.action === 'jump') return schedule('jump', {}, Math.min(ticks, 5));
        if (args.action === 'release') { interrupt('release command'); finishUse(); keys({}); return { released: true }; }
        if (args.action === 'use' || args.action === 'bow') {
          if (args.action === 'bow' && !['bow', 'crossbow'].includes(String(mc.player.getMainHandItem().getUseAnimation()).toLowerCase())) throw new Error('Select a bow or crossbow in the hotbar first');
          const receipt = schedule('use', {}, ticks);
          heldUse = { kind: 'manual', previousSlot: null, slot: null, until: tickCount + ticks };
          keys({ use: true });
          mc.gameMode.useItem(mc.player, Hand.MAIN_HAND);
          return receipt;
        }
      }
      throw new Error('Unknown player operation');
    }
    function react() {
      if (!enabled) return;
      if (!mc.player || !mc.level || !mc.gameMode || !mc.player.isAlive()) { disarm('death or disconnect'); return; }
      if (mc.screen !== null || mc.isPaused()) { disarm('screen opened or game paused'); return; }
      if (mode() !== 'survival' || mc.player.isPassenger()) { disarm('not an unmounted survival player'); return; }
      if (String(mc.player.getUUID()) !== playerId || String(mc.level.dimension().location()) !== dimension) { disarm('player or dimension changed'); return; }
      if (!leaseValid(session)) { disarm('MCP lease expired'); return; }
      if (GLFW.glfwGetKey(mc.getWindow().getWindow(), GLFW.GLFW_KEY_F8) === GLFW.GLFW_PRESS) { disarm('F8 emergency stop'); return; }
      const p = mc.player, currentHealth = Number(p.getHealth());
      if (p.isSleeping()) { disarm('sleeping'); return; }
      if (modKey && tickCount >= modKey.until) { modKey.binding.setDown(false); modKey = null; }
      if (lastHealth !== null && currentHealth < lastHealth) { hurtUntil = tickCount + 40; event('damage', 'Health decreased from ' + lastHealth + ' to ' + currentHealth); }
      lastHealth = currentHealth;
      if (clutch()) return;
      if (p.isUnderWater() && p.getAirSupply() < 100) {
        interrupt('low air'); finishUse(); keys({ jump: true }); p.setXRot(-45); event('reaction', 'Swimming upward for air'); return;
      }
      const danger = threats(), nearest = danger.length ? danger[0] : null;
      if (p.isInLava() || p.isOnFire()) { finishUse(); retreat(nearest, 'fire or lava'); return; }
      if (nearest && (nearest.projectile || nearest.explosive || currentHealth <= config.fleeHealth || tickCount < hurtUntil)) {
        finishUse();
        if (!retreat(nearest, nearest.projectile ? 'incoming projectile' : 'retreat from threat')) { lookAt(nearest.entity); shield(); }
        return;
      }
      if (nearest && nearest.distance < 4 && config.autoDefend) {
        interrupt('nearby hostile');
        if (heldUse && heldUse.kind !== 'shield') finishUse();
        lookAt(nearest.entity);
        if (config.weaponSlot !== null) p.getInventory().selected = config.weaponSlot;
        if (canAttack(nearest.entity) && p.getAttackStrengthScale(0.5) >= 0.9) { finishUse(); keys({ sneak: true }); attack(nearest.entity); }
        else if (!shield()) keys({ sneak: true });
        event('reaction', 'Defending against ' + nearest.id); return;
      }
      if (heldUse) {
        if (tickCount >= heldUse.until || heldUse.kind === 'shield' || heldUse.kind === 'food' && !p.isUsingItem()) { finishUse(); keys({}); }
        else { keys({ use: true }); return; }
      }
      if (config.autoEat && !nearest && p.getFoodData().getFoodLevel() < config.eatBelow && eat()) { interrupt('automatic food'); return; }
      if (action && tickCount >= action.until) { event('completed', 'Action ' + action.id); action = null; keys({}); }
      let direction = action && action.kind === 'move' ? action.direction : 'forward';
      let vector = heading(direction);
      const velocity = p.getDeltaMovement();
      if (!action && velocity.x * velocity.x + velocity.z * velocity.z > 0.001) {
        const length = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
        vector = { x: velocity.x / length, z: velocity.z / length };
      }
      const moving = action && action.kind === 'move' || velocity.x * velocity.x + velocity.z * velocity.z > 0.001;
      if (moving && p.onGround() && !safeDirection(vector.x, vector.z, true)) {
        interrupt('ledge, obstacle or hazardous ground'); finishUse(); keys({ sneak: true });
        event('reaction', 'Stopped unsafe ground movement'); return;
      }
      if (!action) { keys({}); reason = 'watching'; return; }
      if (action.kind === 'move') {
        const values = { sprint: action.sprint && p.getFoodData().getFoodLevel() > 6, sneak: action.sneak };
        values[action.direction] = true;
        keys(values);
      } else if (action.kind === 'jump') keys({ jump: true });
    }
    function tick() {
      tickCount++;
      try {
        const stop = read('stop.json', 2048);
        if (enabled && stop && stop.session === session) disarm('MCP emergency stop');
        emergency = false;
        inReaction = true;
        try { react(); } finally { inReaction = false; } // Never waits for the MCP request queue.
        const request = read('request.json', 16384);
        if (request && request.id !== lastId) {
          if (typeof request.id !== 'string' || request.id.length > 64) throw new Error('Invalid request ID');
          lastId = request.id;
          let response;
          try {
            if (request.protocol !== 1 || !Number.isFinite(request.expiresAt) || request.expiresAt < Date.now() || request.expiresAt > Date.now() + 30000) throw new Error('Invalid or expired request');
            response = { protocol: 1, id: request.id, ok: true, observedAt: new Date().toISOString(), data: handle(request.operation, request.args || {}) };
          } catch (e) { response = { protocol: 1, id: request.id, ok: false, observedAt: new Date().toISOString(), error: String(e) }; }
          publish(response);
        }
        if (tickCount % 20 === 0) { lastError = null; health('ticking'); }
      } catch (e) {
        lastError = String(e);
        try { disarm('controller error'); } catch (releaseError) { lastError += '; key release: ' + releaseError; }
        health('error'); console.error('[ATM10 MCP] Player controller: ' + lastError);
      }
    }
    ClientEvents.tick(tick);
    ClientEvents.loggedOut(() => { disarm('logged out'); health('disconnected'); });
    health('ready');
  } catch (e) {
    lastError = String(e); health('load_error'); console.error('[ATM10 MCP] Player companion failed to load: ' + e);
  }
})();
