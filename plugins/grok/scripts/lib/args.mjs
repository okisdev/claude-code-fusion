export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;
  let positionalStarted = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough || (config.optionsBeforePositionals && positionalStarted) || token === "-") {
      positionals.push(token);
      positionalStarted = true;
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      positionalStarted = true;
      continue;
    }

    const long = token.startsWith("--");
    const raw = long ? token.slice(2) : token.slice(1);
    const separator = long ? raw.indexOf("=") : -1;
    const rawKey = separator === -1 ? raw : raw.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : unquoteOptionValue(raw.slice(separator + 1));
    const key = aliasMap[rawKey] ?? rawKey;

    if (booleanOptions.has(key)) {
      if (!long && raw.length > 1 && !aliasMap[raw]) {
        throw new Error(`Unknown option -${raw}.`);
      }
      if (inlineValue !== undefined && inlineValue !== "true" && inlineValue !== "false") {
        throw new Error(`Invalid boolean value for --${rawKey}: ${inlineValue}.`);
      }
      options[key] = inlineValue === undefined || inlineValue === "true";
      continue;
    }
    if (valueOptions.has(key)) {
      const nextValue = inlineValue ?? unquoteOptionValue(argv[index + 1]);
      if (nextValue === undefined || (inlineValue === undefined && isKnownOptionToken(nextValue, valueOptions, booleanOptions, aliasMap))) {
        throw new Error(`Missing value for ${long ? "--" : "-"}${rawKey}.`);
      }
      options[key] = nextValue;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    throw new Error(`Unknown option ${token}. Use -- before prompt text that begins with a dash.`);
  }

  return { options, positionals };
}

export function parseRawArgs(value, config = {}) {
  const input = String(value ?? "");
  const tokens = rawArgumentTokens(input);
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionalIndexes = [];
  let passthrough = false;
  let positionalStarted = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const tokenInfo = tokens[index];
    const token = tokenInfo.value;
    if (passthrough || (config.optionsBeforePositionals && positionalStarted) || token === "-") {
      positionalIndexes.push(index);
      positionalStarted = true;
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    if (!token.startsWith("-")) {
      positionalIndexes.push(index);
      positionalStarted = true;
      continue;
    }

    const long = token.startsWith("--");
    const raw = long ? token.slice(2) : token.slice(1);
    const separator = long ? raw.indexOf("=") : -1;
    const rawKey = separator === -1 ? raw : raw.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : unquoteOptionValue(raw.slice(separator + 1));
    const key = aliasMap[rawKey] ?? rawKey;

    if (booleanOptions.has(key)) {
      if (tokenInfo.unterminatedQuote) {
        throw new Error(`Unterminated quote in --${rawKey}.`);
      }
      if (!long && raw.length > 1 && !aliasMap[raw]) {
        throw new Error(`Unknown option -${raw}.`);
      }
      if (inlineValue !== undefined && inlineValue !== "true" && inlineValue !== "false") {
        throw new Error(`Invalid boolean value for --${rawKey}: ${inlineValue}.`);
      }
      options[key] = inlineValue === undefined || inlineValue === "true";
      continue;
    }
    if (valueOptions.has(key)) {
      const nextTokenInfo = inlineValue === undefined ? tokens[index + 1] : undefined;
      if (tokenInfo.unterminatedQuote || nextTokenInfo?.unterminatedQuote) {
        throw new Error(`Unterminated quote in ${long ? "--" : "-"}${rawKey} value.`);
      }
      const nextValue = inlineValue ?? unquoteOptionValue(nextTokenInfo?.value);
      if (nextValue === undefined || (inlineValue === undefined && isKnownOptionToken(nextValue, valueOptions, booleanOptions, aliasMap))) {
        throw new Error(`Missing value for ${long ? "--" : "-"}${rawKey}.`);
      }
      options[key] = nextValue;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    throw new Error(`Unknown option ${token}. Use -- before prompt text that begins with a dash.`);
  }

  if (positionalIndexes.length === 0) {
    return { options, positionals: [], positionalText: "" };
  }
  const first = positionalIndexes[0];
  const last = positionalIndexes.at(-1);
  const positionalSet = new Set(positionalIndexes);
  for (let index = first; index <= last; index += 1) {
    if (!positionalSet.has(index)) {
      throw new Error("Options cannot split raw prompt text. Place every option before or after the prompt, or put -- before the complete prompt.");
    }
  }
  return {
    options,
    positionals: positionalIndexes.map((index) => tokens[index].value),
    positionalText: input.slice(rawPromptStart(input, tokens, first), rawPromptEnd(input, tokens, last))
  };
}

export function rawBooleanOptionRequested(value, option, config = {}) {
  const expected = `--${option}`;
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const tokens = rawArgumentTokens(String(value ?? ""));
  let requested = false;
  let positionalStarted = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].value;
    if (token === "--") {
      break;
    }
    if ((config.optionsBeforePositionals && positionalStarted) || !token.startsWith("-") || token === "-") {
      positionalStarted = true;
      if (config.optionsBeforePositionals) {
        break;
      }
      continue;
    }
    if (token === expected || token === `${expected}=true`) {
      requested = true;
    }
    if (token === `${expected}=false`) {
      requested = false;
    }
    const long = token.startsWith("--");
    const raw = long ? token.slice(2) : token.slice(1);
    const separator = long ? raw.indexOf("=") : -1;
    const rawKey = separator === -1 ? raw : raw.slice(0, separator);
    if (
      separator === -1 &&
      valueOptions.has(aliasMap[rawKey] ?? rawKey) &&
      !isKnownOptionToken(tokens[index + 1]?.value, valueOptions, booleanOptions, aliasMap)
    ) {
      index += 1;
    }
  }
  return requested;
}

function rawPromptStart(input, tokens, first) {
  if (first === 0) {
    return 0;
  }
  const syntaxEnd = tokens[first - 1].end;
  if (input[syntaxEnd] === "\r" && input[syntaxEnd + 1] === "\n") {
    return syntaxEnd + 2;
  }
  return syntaxEnd + 1;
}

function rawPromptEnd(input, tokens, last) {
  if (last === tokens.length - 1) {
    return input.length;
  }
  const syntaxStart = tokens[last + 1].start;
  if (input[syntaxStart - 2] === "\r" && input[syntaxStart - 1] === "\n") {
    return syntaxStart - 2;
  }
  return syntaxStart - 1;
}

function unquoteOptionValue(value) {
  if (typeof value !== "string" || value.length < 2) {
    return value;
  }
  const first = value[0];
  return (first === "'" || first === '"') && value.at(-1) === first ? value.slice(1, -1) : value;
}

function rawArgumentTokens(input) {
  const tokens = [];
  let quote = null;
  let escaping = false;
  let start = null;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (start == null) {
      if (/\s/.test(character)) {
        continue;
      }
      start = index;
    }
    if (escaping) {
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if ((index === start || input[index - 1] === "=") && (character === "'" || character === '"')) {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      tokens.push({ value: input.slice(start, index), start, end: index, unterminatedQuote: false });
      start = null;
    }
  }

  if (start != null) {
    tokens.push({ value: input.slice(start), start, end: input.length, unterminatedQuote: quote != null });
  }
  return tokens;
}

function isKnownOptionToken(token, valueOptions, booleanOptions, aliasMap) {
  if (!token || token === "-" || !token.startsWith("-")) {
    return false;
  }
  if (token.startsWith("--")) {
    const separator = token.indexOf("=");
    const rawKey = token.slice(2, separator === -1 ? undefined : separator);
    const key = aliasMap[rawKey] ?? rawKey;
    return valueOptions.has(key) || booleanOptions.has(key);
  }
  const key = aliasMap[token.slice(1)] ?? token.slice(1);
  return valueOptions.has(key) || booleanOptions.has(key);
}
