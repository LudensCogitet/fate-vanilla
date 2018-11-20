function Fate() {
	var self = this;
	let pristineWorld;
	let world;
	let started = false;

	let command;

	let response = [];
	let roomEnterResponse = [];

	let interrupt;
	let clear;

	let travelToLocation;
	let actionTaken = false;
	let objectNames = [];

	// 'plus': 'add',
	// 'minus': 'subtract',
	// 'divided by': 'divide',
	// 'multiplied by': 'multiply',
	// 'remainder of division by': 'modulo'

	function resolveModifier(subject) {
		if(!subject.modifier) return resolveValue(subject);

		let {operation} = subject.modifier;
		let operand = resolveOperand(subject.modifier.operand);

		if(operation === 'add')
			return resolveValue(subject) + operand;
		if(operation === 'subtract')
			return resolveValue(subject) - operand;
		if(operation === 'divide')
			return resolveValue(subject) / operand;
		if(operation === 'multiply')
			return resolveValue(subject) * operand;
		if(operation === 'modulo')
			return resolveValue(subject) % operand;
	}

	function resolveValue(operand) {
		if(operand.variable) {
			return resolveValue(world.variables[operand.variable]);
		}

		let value = Number(operand.value);
		if(value || value === 0) {
			return value;
		} else {
			return operand.value;
		}
	}

	function resolveOperand(operand) {
		if(!operand.hasOwnProperty('value') && !operand.hasOwnProperty('variable')) return false;

		if(operand.value === '#here') return world.things['#player'].location;
		if(operand.value === '#command') return command;

		let resolved = {
			value: resolveValue(operand)
		};

		if(operand.modifier) resolved.modifier = operand.modifier;

		return resolveModifier(resolved);
	}

	function wrapOperand(operand) {
		if(world.variables[operand]) return {variable: operand};

		return {value: operand};
	}

	function processIf(subject) {
		let comparisons = [subject.if];
		let results = [];
		if(subject.or) comparisons = comparisons.concat(subject.or);

		for(let comparison of comparisons) {
			if(comparison.eq) {
				results.push(resolveOperand(comparison.eq[0]) === resolveOperand(comparison.eq[1]));
			} else if(comparison.neq) {
				results.push(resolveOperand(comparison.neq[0]) !== resolveOperand(comparison.neq[1]));
			} else if(comparison.in) {
				results.push(world.things[resolveOperand(comparison.in[0])].location === resolveOperand(comparison.in[1]));
			} else if(comparison.nin) {
				results.push(world.things[resolveOperand(comparison.nin[0])].location !== resolveOperand(comparison.nin[1]));
			}
		}

		return results.some(x => x);
	}

	function processDo(subject) {
		let toProcess = subject.function ? world.functions[resolveOperand(subject.function)] : subject;
		toProcess.forEach(x => {
			process(x);
		});
	}

	function processTravel(subject) {
		travelToLocation = resolveOperand(subject);
	}

	function processSay(subject) {
		subject.forEach(x => {
			let value = resolveOperand(x);
			if(value) {
				command === '#enter' ? roomEnterResponse.push(value) : response.push(value);
				return;
			}
			process(x);
		});
	}

	function processMove(subject) {
		let thing = resolveOperand(subject[0]);
		let destination = resolveOperand(subject[1]);

		world.things[thing].location = destination;
	}

	function processSet(subject) {
		world.variables[resolveOperand(subject[0])] = wrapOperand(resolveOperand(subject[1]));
	}

	function processList(subject) {
		let location = resolveOperand(subject.location);
		let phrase = resolveOperand(subject.phrase);
		let things = Object.keys(world.things).filter(x => world.things[x].location === location && x !== '#player');

		console.log("THINGS", things);

		things.forEach(thing => response.push(phrase.replace('#thing', world.things[thing].description)));
	}

	function processClear(subject) {
		console.log("CLEAR");
		clear = true;
		response = [];
	}

	function processAction(subject) {
		let actions = {
			"travel": processTravel,
			"say": processSay,
			"move": processMove,
			"set": processSet,
			"list": processList,
			"clear": processClear
		};

		for(let action of Object.keys(actions)) {
			if(subject[action]) {
				actionTaken = true;
				actions[action](subject[action]);
				interrupt = subject[action].interrupt;
				break;
			}
		}
	}

	function process(subject) {
		if(interrupt) return;
		if(subject.do)
			processDo(subject.do);
		else if(subject.if){
			if(processIf(subject)) {
				process(subject.then);
			} else if(subject.else) {
				process(subject.else);
			}
		} else {
			processAction(subject);
		}
	}

	function getThingsAtLocation(location) {
		let thingsAtLocation = [];

		let thingNames = Object.keys(world.things);

		for(let thing of thingNames) {
			if(world.things[thing].location === location)
				thingsAtLocation.push(thing);
		}

		return thingsAtLocation;
	}

	function checkPlayerMoved() {
		if(!travelToLocation) return;

		interrupt = false;
		while(travelToLocation) {
			world.things['#player'].location = travelToLocation;
			travelToLocation = null;
			command = '#enter';
			process(world.places[world.things['#player'].location]);
		}
	}

	function filterCommand(newCommand) {
		if(newCommand === '#enter') return newCommand;
		let {keywords} = world.settings;

		let words = [];

		keywords.forEach(keyword => {
			words.push(keyword.keyword);
			if(keyword.synonyms) {
				keyword.synonyms.forEach(synonym => {
					newCommand = newCommand.replace(synonym, keyword.keyword);
				});
			}
		});

		let matches = [];

		words.concat(objectNames).forEach(word => {
			 let match = newCommand.match(new RegExp(`.*(${word}).*`));
			 if(match) matches.push(match);
		});

		return matches.map(x => x[1]).sort((a, b) => newCommand.indexOf(a) - newCommand.indexOf(b)).join(' ');
	}

	this.load = function(worldString) {
		pristineWorld = worldString;
		world = JSON.parse(worldString);

		objectNames = objectNames.concat(Object.keys(world.things), Object.keys(world.places));

		return world.settings;
	}

	this.move = function(newCommand) {
		if(!world || !started) return;
		command = newCommand;
		// if(world.settings.keywords) {
		// 	command = filterCommand(newCommand);
		// } else {
		// 	command = newCommand;
		// }

		let anywhere				= world['#anywhere'];
		let currentPlace 		= world.places[world.things['#player'].location];
		let localThings			= getThingsAtLocation(world.things['#player'].location);
		let playerThings		= getThingsAtLocation('#player');

		process(currentPlace);
		localThings.forEach(x => {
			process(world.things[x]);
		});

		playerThings.forEach(x => {
			process(world.things[x]);
		});
		process(anywhere);

		checkPlayerMoved();

		response = roomEnterResponse.concat(response);
		let compiledResponse = !response.length ? world.settings.onBadCommand : response.join(' ');

		response = [];
		roomEnterResponse = [];
		interrupt = false;

		world.variables['#turn'].value = ((+world.variables['#turn'].value) + 1) + '';

		let packet = {
			response: compiledResponse,
			world,
			currentLocation: {
				name: world.things['#player'].location,
				description: resolveValue(world.places[world.things['#player'].location].description)
			},
			//actionTaken
			clear
		};
		clear = false;
		actionTaken = false;
		return packet;
	}

	this.start = function() {
		if(!world) return;
		started = true;

		return self.move(`#enter`);
	}
}
