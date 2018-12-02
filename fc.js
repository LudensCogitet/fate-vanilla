let fs = require('fs');
let path = require('path');
let util = require('util');

let playerCompiled = false;
let folderPath;

function escapeSymbol(symbol) {
	return symbol.replace(/\$/g, "\\$").replace(/\|/g, "\\|").trim();
}

function captureModifier(text, symbol) {
	symbol = escapeSymbol(symbol);
	let modifiers = {
		'plus': 'add',
		'minus': 'subtract',
		'divided by': 'divide',
		'multiplied by': 'multiply',
		'remainder of division by': 'modulo'
	};

	for(let modifier of Object.keys(modifiers)) {
		let match = text.match(new RegExp(`.*${symbol}\\s${modifier}.*`));
		if(match) {
			return {operation: modifiers[modifier], operand: captureExpression(text, modifier)};
		}
	}
}

function captureKeyword(text) {
	if(text.indexOf('#interrupt') > -1) {
		return 'interrupt';
	}
}

function captureExpression(text, symbol = '') {
	symbol = escapeSymbol(symbol);
	let regex = [
			new RegExp(`${symbol}\\s\\\`(.*?)\\\``),
			new RegExp(`${symbol}\\s\\\$(.*?)\\\$`),
			new RegExp("^`(.*?)`"),
			new RegExp("^\\\$(.*?)\\\$"),
			new RegExp(`${symbol}\\s(.*?)(\\s|$)`)
	];

	for(let i = 0; i < regex.length; i++) {
		let match = text.match(regex[i]);
		if(match && match.length > 1) {
			let modifier = captureModifier(text, match[0]);
			let keyword = captureKeyword(text);
			let expression = {};
			if(modifier) expression.modifier = modifier;
			if(keyword) expression[keyword] = true;

			switch(i) {
				case 0:
				case 2:
				case 4:
					expression.value = match[1];
					return expression;
				case 1:
				case 3:
					expression.variable = match[1]
					return expression;
			}
		}
	}

	return null;
}

function errorAndExit(error, statement = null) {
	if(!statement) console.error(error);
	else {
		console.error(`Error at line ${statement.line}: '${statement.text}'`);
		console.error(`ERROR: ${error}`);
	}
	process.exit(1);
}

function validateFilePath(sourceFile) {
	if(!sourceFile || !fs.existsSync(sourceFile)) {
	  errorAndExit(`Bad source file path: ${sourceFile}`);
	}
}

function assignLayers(lines) {
	let statements = [];
	for(let line of lines) {
		let layer = 0;
	  for(let i = 0; i < line.length; i++) {
			if(line[i] === '\t') layer++;
	  }
		statements.push({layer, text: line.trim()});
	}

	return statements;
}

function groupStatements(lines) {
	let statements = [];
	let currentObjects = [null];
	assignLayers(lines).forEach((line, i) => {
		if(!line.text || line.text.slice(0, 2) === '<!') return;

		if(line.layer === 0) {
			currentObjects[0] = {text: line.text, line: i}
			statements.push(currentObjects[0]);
		} else {
			let newObject = {text: line.text, line: i};
			currentObjects[line.layer] = newObject;
			currentObjects[line.layer - 1].children ? currentObjects[line.layer - 1].children.push(newObject) : currentObjects[line.layer - 1].children = [newObject];
		}
	});

	return statements;
}

function compilePlace(statement, compiled) {
	if(!statement.children) errorAndExit("Empty 'place' statement", statement);

	let placeName = captureExpression(statement.text, 'named');
	if(!placeName || placeName.variable) errorAndExit("Place must be named and name must not be a variable", statement);

	let placeDescription = captureExpression(statement.text, 'looks like');
	// if(!placeDescription || placeDescription.variable) errorAndExit("A place must have a description and description must not be a variable", statement);

	let newPlace = {
		description: placeDescription && placeDescription.value ? placeDescription : ''
	};

	statement.children.forEach(child => {
		compileStatement(child, newPlace);
	});

	if(!compiled.places) compiled.places = {};
	compiled.places[placeName.value] = newPlace;
}

function compileThing(statement, compiled) {
	if(!statement.children) errorAndExit("Empty 'thing' statement", statement);

	let thingName = captureExpression(statement.text, 'named');
	if(!thingName || thingName.variable) errorAndExit("Thing must be named and name must not be a variable", statement);

	let thingLocation = captureExpression(statement.text, 'is in');
	if(!thingLocation || thingLocation.variable) errorAndExit("Thing must have a location and location must not be a variable", statement);

	let thingDescription = captureExpression(statement.text, 'looks like');
	if(!thingDescription || thingDescription.variable) errorAndExit("Thing must have a description and description must not be a variable", statement);

	let newThing = {
		location: thingLocation.value,
		description: thingDescription.value
	};

	statement.children.forEach(child => {
		compileStatement(child, newThing);
	});

	if(!compiled.things) compiled.things = {};
	compiled.things[thingName.value] = newThing;
}

function compileDo(statement, compiled) {
	let functionName = captureExpression(statement.text, 'do');
	if(functionName) {
		if(statement.children) errorAndExit("Unreachable inline 'do' commands", statement);
		compiled.do = {function: functionName};
		return;
	}

	if(!statement.children) errorAndExit("Empty 'do' statement", statement);
	if(!compiled.do) compiled.do = [];

	statement.children.forEach(child => {
		let newCommand = {};
		compileStatement(child, newCommand);
		compiled.do.push(newCommand);
	});
}

function compileFunction(statement, compiled) {
	if(!statement.children) errorAndExit("Empty function statement", statement);

	let functionName = captureExpression(statement.text, 'named');
	if(!functionName || functionName.variable) errorAndExit("Function must be named and name must not be a variable", statement);

	if(!compiled.functions) compiled.functions = {};

	compiled.functions[functionName.value] = [];

	statement.children.forEach(child => {
		let newCommand = {};
		compileStatement(child, newCommand);
		compiled.functions[functionName.value].push(newCommand);
	});
}

function compileComparison(command, statement) {
	let {text} = statement;
	let comparisons = {
		"is not in": "nin",
		"is not": "neq",
		"is in": "in",
		"is": "eq",
		"does not have": "nin",						// converted to nin with operands flipped
		"has": "in"											// converted to in with operands flipped
	}

	let leftHandOperand = captureExpression(statement.text, command);

	if(!leftHandOperand) errorAndExit(`No left hand operand in "${command}" statement.`, statement);

	let rightHandOperand;
	let operator;
	Object.keys(comparisons).some(key => {
		rightHandOperand = captureExpression(statement.text, key);
		if(rightHandOperand) operator = key;
		return rightHandOperand;
	});

	if(!operator) errorAndExit(`No known operator in "${command}" statement`, statement);
	if(!rightHandOperand) errorAndExit(`Missing right hand operand or invalid operator in "${command}" statement.`, statement);

	if(operator === 'has' || operator === 'does not have') {
		let temp = leftHandOperand;
		leftHandOperand = rightHandOperand;
		rightHandOperand = temp;
	}

	return { operator: comparisons[operator], operands: [leftHandOperand, rightHandOperand] };
}

function compileIf(statement, compiled) {
	if(!statement.children) errorAndExit(`'If' statements must have at least one child.`, statement);

	let orStatements = statement.children.filter(x => x.text.match(/^or/));
	let thenStatement = statement.children.find(x => x.text.match(/^then/));
	let elseStatement = statement.children.find(x => x.text.match(/^else/));

	if(thenStatement && (!thenStatement.children || thenStatement.children.length !== 1))
		errorAndExit(`"then" statement must have one child and no more`, thenStatement);

	if(orStatements.length && !thenStatement) errorAndExit('"If" statment must have at least one "then" child if "or" children are present.', statement);

	let comparison = compileComparison('if', statement);

	compiled.if = {};
	compiled.if[comparison.operator] = comparison.operands;

	if(orStatements.length) {
		compiled.or = orStatements.map(x => {
			comparison = compileComparison('or', x);
			let newOr = {};
			newOr[comparison.operator] = comparison.operands;
			return newOr;
		});
	}

	compiled.then = {};
	compileStatement(thenStatement ? thenStatement.children[0] : statement.children[0], compiled.then);

	if(elseStatement) {
		compiled.else = {};
		compileStatement(elseStatement.children[0], compiled.else);
	}
}

function compileVariable(statement, compiled) {
	if(statement.children) errorAndExit(`Variable declarations must not have children`, statement);

	let variableName = captureExpression(statement.text, 'named');
	if(!variableName || variableName.variable)  errorAndExit("Variable must have a name and name must not be a variable", statement);

	let variableValue = captureExpression(statement.text, 'is');
	if(!variableValue || variableValue.variable)  errorAndExit("Variable must have a value and value cannot be a variable", statement);

	if(!compiled.variables) compiled.variables = {};
	compiled.variables[variableName.value] = variableValue;
}

function compileTravel(statement, compiled) {
	if(statement.children) errorAndExit(`Travel statements must not have children`, statement);

	let destination = captureExpression(statement.text, 'to');
	if(!destination)  errorAndExit("Travel statement must have a destination", statement);

	compiled.travel = destination;
}

function compileSay(statement, compiled) {
	if(!compiled.say) compiled.say = [];

	let inlineText = captureExpression(statement.text);

	if(inlineText) {
		compiled.say.push(inlineText);
		return;
	} else if(!statement.children) {
		errorAndExit("Empty say statement", statement);
	}

	statement.children.forEach(child => {
		let newCommand = {};
		compileStatement(child, newCommand);
		compiled.say.push(newCommand);
	});
}

function compileMove(statement, compiled) {
	let thing = captureExpression(statement.text, 'move');
	if(!thing) errorAndExit("No thing specified to move", statement);

	let destination = captureExpression(statement.text, 'to');
	if(!destination)  errorAndExit("No destination specified", statement);

	compiled.move = [thing, destination];
}

function compilePlayer(statement, compiled) {
	if(statement.children) errorAndExit("Player initialization statements cannot have children");

	let location = captureExpression(statement.text, 'is in');
	if(!location || location.variable) errorAndExit("Player must be initialized with a location and location cannot be a variable");

	if(!compiled.things) compiled.things = {};
	compiled.things['#player'] = {};

	compiled.things['#player'].location = location.value;
	playerCompiled = true;
}

function compileAnywhere(statement, compiled) {
	if(!statement.children) errorAndExit("Anywhere initialization statement must have children");

	if(!compiled['#anywhere']) compiled['#anywhere'] = {};

	statement.children.forEach(child => {
		compileStatement(child, compiled['#anywhere']);
	});
}

function compileClear(statement, compiled) {
	compiled.clear = true;
}

function compileSet(statement, compiled) {
	if(statement.children) errorAndExit("Set statements cannot have children");

	let variable = captureExpression(statement.text, 'set');
	if(!variable || variable.variable) errorAndExit("First operand of set statement must be a variable name and not a variable.", statement);

	let value = captureExpression(statement.text, 'to');
	if(!value) errorAndExit("Set statement must assign a value.", statement);

	compiled.set = [variable, value];
}

function compileList(statement, compiled) {
	if(statement.children) errorAndExit("List statements cannot have children");

	let location = captureExpression(statement.text, 'what is in');
	if(!location) location = captureExpression(statement.text, 'what');
	if(!location) errorAndExit("List statements must mention a location");

	let phrase = captureExpression(statement.text, 'saying');
	if(!phrase) errorAndExit("List statements must give a template");

	compiled.list = {location, phrase};
}

function compileSettings(statement, compiled) {
	compiled.settings = {};
	statement.children.forEach(setting => {
		let match;
		// match = setting.text.match(/turns happen on (.*)/)
		// if(match && match.length) {
		// 	if(match[1] !== 'input' && match[1] !== 'command')
		// 		errorAndExit(`Turns must happen on either "input" or "command"`, statement);
		//
		// 	compiled.settings.registerTurn = match[1];
		// 	return;
		// }
		//
		// match = setting.text.match(/turns happen every ([0-9]+) commands/);
		//
		// if(match && match.length) {
		// 	compiled.settings.commandsPerTurn = match[1];
		// 	return;
		// }

		match = captureExpression(setting.text, 'bad command response');

		if(match) {
			compiled.settings.onBadCommand = match.value || match.variable;
		}

		match = setting.text.match(/keyword list/);
		if(match) {
			setting.children.forEach(keyword => {
				if(!compiled.settings.keywords) compiled.settings.keywords = [];
				let keywordObject = {keyword: keyword.text};
				if(keyword.children && keyword.children[0].text.match(/synonyms/)) {
					keyword.children[0].children.forEach(x => {
						if(!keywordObject.synonyms) keywordObject.synonyms = [];

						let synonym;
						let match = x.text.match(/`(.*?)`/);
						if(match && match.length) synonym = match[1];
						else synonym = x.text;

						keywordObject.synonyms.push(synonym);
					});
				}
				compiled.settings.keywords.push(keywordObject);
			});
		}
	});
}

let compile = {
	"import":			compileImport,
	"place": 			compilePlace,
	"do":					compileDo,
	"if":					compileIf,
	"thing":			compileThing,
	"variable": 	compileVariable,
	"travel":			compileTravel,
	"say":				compileSay,
	"move":				compileMove,
	"set":				compileSet,
	"list":				compileList,
	"function":		compileFunction,
	"#clear":			compileClear,
	"#player":		compilePlayer,
	"#anywhere":	compileAnywhere,
	"#settings":	compileSettings
}

function compileStatement(statement, compiled) {
	let command = statement.text.split(' ').shift();

	if(!compile[command]) {
		console.log(statement.text);
		if(captureExpression(statement.text)) {
			compile['say'](statement, compiled);
			return;
		}
		else {
			errorAndExit(`Invalid command '${command}'`, statement);
		}
	}

	compile[command](statement, compiled);
}

function compileImport(statement, compiled) {
	let filename = captureExpression(statement.text, 'import');

	if(!filename) errorAndExit("No filename specified.", statement);
	if(filename.variable) errorAndExit("Filename cannot be a variable.", statement);

	compileFile(filename.value, compiled);
}

const worldStructure = {
	'#anywhere': {},
	'places': {},
	'things': {},
	'variables': {},
	'functions': {}
};

function compileFile(filename, compiled) {
	filename = path.join(__dirname, folderPath, filename);
	validateFilePath(filename);

	let source = fs.readFileSync(filename, 'utf8');
	let grouped = groupStatements(source.split('\n'));
	console.log(grouped);
	for(let statement of grouped) {
		compileStatement(statement, compiled);
	}
}

function serializeWorldObject(compiled) {
	return JSON.stringify(compiled).replace(/\\"/g, '\\\\\\"');
}

(() => {
	let sourceFile = process.argv[2];

	let parts = sourceFile.split(path.sep);
	let initScript;
	if(parts[parts.length -1].indexOf('.ft') === -1) {
		initScript = 'index.ft';
	} else {
		initScript = parts[parts.length -1];
		parts.pop();
	}
	folderPath = parts.join(path.sep);

	let destinationPath = process.argv[3];

	let compiled = {};

	compileFile(initScript, compiled);

	if(!playerCompiled) errorAndExit(`Player must be initialized with a location. E.g. "#player is in \`room_name\`"`);

	compiled = Object.assign({}, worldStructure, compiled);

	compiled.variables['#turn'] = {value: '1'};
	if(!compiled.settings) compiled.settings = {};

	console.log(serializeWorldObject(compiled));

	if(!destinationPath) {
		let dateNow = new Date();
		destinationPath = `./fateWorld_${dateNow.getFullYear()}-${dateNow.getMonth()+1}-${dateNow.getDate()}.ftw`;
	}

	fs.writeFileSync(destinationPath, serializeWorldObject(compiled));
	process.exit(0);
})();
