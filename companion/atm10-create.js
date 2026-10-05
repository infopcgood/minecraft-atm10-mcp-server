// Optional direct Create 6.0.10 adapter for Minecraft 1.21.1 / KubeJS 2101.
// Install alongside atm10-inspector.js. Enables world mutations through the local bridge.
// Uses native Create APIs, never ComputerCraft, reflection, arbitrary NBT writes or setSpeed().
(() => {
  let api;
  function classes() {
    if (api) return api;
    const root = 'com.simibubi.create.';
    // Lazy loading keeps the inspector usable when Create is absent.
    const loaded = {
      Kinetic: Java.loadClass(root + 'content.kinetics.base.KineticBlockEntity'),
      Controller: Java.loadClass(root + 'content.kinetics.speedController.SpeedControllerBlockEntity'),
      Motor: Java.loadClass(root + 'content.kinetics.motor.CreativeMotorBlockEntity'),
      SplitShaft: Java.loadClass(root + 'content.kinetics.transmission.SplitShaftBlockEntity'),
      Chain: Java.loadClass(root + 'content.kinetics.chainDrive.ChainGearshiftBlockEntity'),
      Sequencer: Java.loadClass(root + 'content.kinetics.transmission.sequencer.SequencedGearshiftBlockEntity'),
      Instruction: Java.loadClass(root + 'content.kinetics.transmission.sequencer.Instruction'),
      Modes: Java.loadClass(root + 'content.kinetics.transmission.sequencer.SequencerInstructions'),
      Modifiers: Java.loadClass(root + 'content.kinetics.transmission.sequencer.InstructionSpeedModifiers'),
      Configs: Java.loadClass(root + 'infrastructure.config.AllConfigs'),
      Properties: Java.loadClass('net.minecraft.world.level.block.state.properties.BlockStateProperties'),
      Direction: Java.loadClass('net.minecraft.core.Direction'),
      Registries: Java.loadClass('net.minecraft.core.registries.BuiltInRegistries'),
      ModList: Java.loadClass('net.neoforged.fml.ModList')
    };
    api = loaded;
    return api;
  }
  const operations = ['create_inspect', 'create_speed', 'create_transmission', 'create_configure_sequence', 'create_run_sequence'];
  function capabilities() {
    try {
      const a = classes();
      const mod = a.ModList.get().getModContainerById('create');
      return { available: true, version: mod.isPresent() ? String(mod.get().getModInfo().getVersion()) : 'unknown',
        sourceCheckedVersion: '6.0.10', operations: operations, controlsEnabled: true,
        limits: ['Loaded stationary block entities only; no moving contraption entities',
          'Network totals are cached by Create, not a full topology scan',
          'Adjustable chain gearshift ratio is controlled by redstone',
          'Gearshift/clutch powered state may be replaced by later redstone updates'] };
    } catch (e) { return { available: false, reason: 'Create is absent or its API is incompatible', error: String(e) }; }
  }
  function xyz(pos) {
    return pos === null ? null : { x: Number(pos.getX()), y: Number(pos.getY()), z: Number(pos.getZ()) };
  }
  function identify(t, a) {
    return { dimension: t.dimension, x: Number(t.pos.getX()), y: Number(t.pos.getY()), z: Number(t.pos.getZ()),
      id: String(a.Registries.BLOCK.getKey(t.state.getBlock())) };
  }
  function inspect(server, t, a) {
    const be = t.be;
    const identity = identify(t, a);
    if (!(be instanceof a.Kinetic)) return Object.assign({}, identity, { supported: false, reason: 'Block entity is not a Create kinetic machine' });
    const rpm = Number(be.getSpeed());
    const theoretical = Number(be.getTheoreticalSpeed());
    const data = be.saveWithoutMetadata(server.registryAccess());
    const properties = {};
    const it = t.state.getProperties().iterator();
    while (it.hasNext()) {
      const property = it.next();
      properties[String(property.getName())] = String(t.state.getValue(property));
    }
    const result = Object.assign({}, identity, { supported: true, adapter: 'create', state: properties,
      rotation: { rpm: rpm, theoreticalRpm: theoretical, generatedRpm: Number(be.getGeneratedSpeed()),
        axis: String(t.state.getBlock().getRotationAxis(t.state)).toLowerCase(),
        sign: rpm === 0 ? 'stopped' : rpm > 0 ? 'positive' : 'negative',
        signConvention: 'Create axis convention; clockwise depends on viewing face',
        overstressed: Boolean(be.isOverStressed()), meetsSpeedRequirement: Boolean(be.isSpeedRequirementFulfilled()) },
      source: be.hasSource() ? xyz(be.source) : null,
      network: { connected: false }, controls: [] });
    if (be.hasNetwork() && data.contains('Network')) {
      const network = data.getCompound('Network');
      const capacity = Number(network.getFloat('Capacity'));
      const stress = Number(network.getFloat('Stress'));
      result.network = { connected: true, id: String(network.get('Id').getAsString()).replace(/[lL]$/, ''),
        stress: stress, capacity: capacity, remainingCapacity: capacity - stress, unit: 'SU',
        utilization: capacity > 0 ? stress / capacity : null, cachedSize: Number(network.getInt('Size')),
        stressEnabled: !Boolean(a.Configs.server().kinetics.disableStress.get()), source: 'Create cached block-entity network snapshot' };
    }
    if (be instanceof a.Controller || be instanceof a.Motor) {
      const motor = be instanceof a.Motor;
      result.speedSetting = { rpm: Number((motor ? be.generatedSpeed : be.targetSpeed).getValue()),
        maxRpm: Math.min(motor ? Number(a.Motor.MAX_SPEED) : Infinity, Number(a.Configs.server().kinetics.maxRotationSpeed.get())),
        kind: motor ? 'creative_motor' : 'rotation_speed_controller' };
      result.controls.push('set-create-speed');
    }
    if (be instanceof a.SplitShaft) {
      const axis = result.rotation.axis;
      const faces = axis === 'x' ? ['west', 'east'] : axis === 'y' ? ['down', 'up'] : ['north', 'south'];
      result.transmission = { faces: faces.map(name => {
        const modifier = Number(be.getRotationSpeedModifier(a.Direction.byName(name)));
        return { face: name, modifier: modifier, rpm: rpm * modifier };
      }) };
    }
    if (identity.id === 'create:gearshift' || identity.id === 'create:clutch') {
      const powered = Boolean(t.state.getValue(a.Properties.POWERED));
      result.transmission.powered = powered;
      result.transmission.mode = identity.id === 'create:clutch' ? (powered ? 'disengaged' : 'engaged') : (powered ? 'reversed' : 'normal');
      result.controls.push('set-create-transmission');
    }
    if (be instanceof a.Chain) result.chainGearshift = {
      signal: Number(data.getInt('Signal')), modifier: Number(be.getModifier()), controlledBy: 'redstone',
      note: 'The chain connection determines whether this multiplier or its reciprocal applies'
    };
    if (be instanceof a.Sequencer) {
      const instructions = data.getList('Instructions', 10);
      const steps = [];
      for (let i = 0; i < Math.min(Number(instructions.size()), 5); i++) {
        const instruction = instructions.getCompound(i);
        steps.push({ type: String(instruction.getString('Type')), modifier: String(instruction.getString('Modifier')), value: Number(instruction.getInt('Value')) });
      }
      result.sequence = { idle: Boolean(be.isIdle()), instructionIndex: Number(data.getInt('InstructionIndex')),
        durationTicks: Number(data.getInt('InstructionDuration')), progress: Number(data.getFloat('InstructionProgress')),
        elapsedTicks: Number(data.getInt('Timer')), modifier: Number(be.getModifier()), steps: steps,
        totalSteps: Number(instructions.size()), progressUnit: 'degrees, blocks, or ticks according to the current instruction' };
      result.controls.push('configure-create-sequence', 'run-create-sequence');
    }
    return result;
  }
  function handle(server, operation, args, helpers) {
    if (!operations.includes(operation)) throw new Error('Unknown Create operation');
    const a = classes();
    const t = helpers.locateBlock(server, args);
    const be = t.be;
    const before = inspect(server, t, a);
    if (operation === 'create_inspect') return before;
    if (!before.supported) throw new Error(before.reason);
    let changed = true;
    if (operation === 'create_speed') {
      if (!(be instanceof a.Controller) && !(be instanceof a.Motor)) throw new Error('Speed setting requires a rotation speed controller or creative motor');
      if (typeof args.rpm !== 'number') throw new Error('rpm must be a number');
      const max = Math.min(before.speedSetting.maxRpm, Number(a.Configs.server().kinetics.maxRotationSpeed.get()));
      const rpm = helpers.integer(args.rpm, undefined, -max, max);
      changed = before.speedSetting.rpm !== rpm;
      // setValue invokes Create's own network update callback and marks/syncs the BE.
      (be instanceof a.Motor ? be.generatedSpeed : be.targetSpeed).setValue(rpm);
    } else if (operation === 'create_transmission') {
      if (before.id !== 'create:gearshift' && before.id !== 'create:clutch') throw new Error('Transmission control supports only a Create gearshift or clutch');
      if (typeof args.powered !== 'boolean') throw new Error('powered must be a boolean');
      const old = Boolean(t.state.getValue(a.Properties.POWERED));
      changed = old !== args.powered;
      if (changed) {
        const next = t.state.setValue(a.Properties.POWERED, args.powered);
        // Match the block's neighborChanged lifecycle, including its reattach tick.
        if (before.id === 'create:clutch') {
          if (!t.level.setBlock(t.pos, next, 2 | 16)) throw new Error('Block state update rejected; inspect target before retrying');
          t.state.getBlock().detachKinetics(t.level, t.pos, old);
        } else {
          t.state.getBlock().detachKinetics(t.level, t.pos, true);
          if (!t.level.setBlock(t.pos, next, 2)) throw new Error('Block state update rejected; inspect target before retrying');
        }
      }
    } else if (operation === 'create_configure_sequence') {
      if (!(be instanceof a.Sequencer)) throw new Error('Target is not a sequenced gearshift');
      if (!be.isIdle()) throw new Error('Stop the running sequence before replacing its program');
      if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 4) throw new Error('Provide 1 to 4 sequence steps');
      // Validate and construct the entire replacement before changing live instructions.
      const modes = { turn_angle: ['TURN_ANGLE', 360], turn_distance: ['TURN_DISTANCE', 128], delay: ['DELAY', 600], await: ['AWAIT', 0] };
      const steps = args.steps.map(step => {
        if (!step || !Object.prototype.hasOwnProperty.call(modes, step.type)) throw new Error('Invalid sequence step type');
        const mode = modes[step.type];
        const modifier = step.modifier === undefined ? 1 : step.modifier;
        if (![-2, -1, 1, 2].includes(modifier)) throw new Error('Invalid sequence speed modifier');
        if ((step.type === 'await' || step.type === 'delay') && modifier !== 1) throw new Error('Only movement steps accept a speed modifier');
        if (step.type === 'await' && step.value !== undefined) throw new Error('await has no value');
        if (mode[1] !== 0 && typeof step.value !== 'number') throw new Error('Sequence step value must be a number');
        const value = mode[1] === 0 ? 0 : helpers.integer(step.value, undefined, 1, mode[1]);
        return new a.Instruction(a.Modes.valueOf(mode[0]), a.Modifiers.getByModifier(modifier), value);
      });
      steps.push(new a.Instruction(a.Modes.END));
      const instructions = be.getInstructions();
      instructions.clear();
      steps.forEach(step => instructions.add(step));
      be.setChanged();
      be.sendData();
    } else if (operation === 'create_run_sequence') {
      if (!(be instanceof a.Sequencer)) throw new Error('Target is not a sequenced gearshift');
      if (args.action !== 'start' && args.action !== 'stop') throw new Error('action must be start or stop');
      if (args.action === 'start') {
        if (!be.isIdle()) throw new Error('Sequence is already running');
        if (Number(be.getSpeed()) === 0) throw new Error('Sequence needs a rotating input that is not overstressed');
        be.run(0);
      } else {
        changed = !be.isIdle();
        be.run(-1);
      }
      be.setChanged();
      be.sendData();
    }
    const result = { applied: true, changed: changed, operation: operation, requested: args, before: before,
      note: 'Setting applied on the server thread. Network propagation and movement may take subsequent ticks; inspect again. Redstone can override transmission state.' };
    // A failed post-write observation must not disguise an already applied action.
    try { result.after = inspect(server, helpers.locateBlock(server, args), a); }
    catch (e) { result.observationError = String(e); }
    return result;
  }
  global.atm10McpCreate = { capabilities: capabilities, handle: handle };
})();
