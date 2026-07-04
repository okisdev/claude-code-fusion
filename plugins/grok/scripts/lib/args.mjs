export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const separator = token.indexOf("=");
      const rawKey = token.slice(2, separator === -1 ? undefined : separator);
      const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}.`);
        }
        if (inlineValue === undefined && isKnownOptionToken(nextValue, valueOptions, booleanOptions, aliasMap)) {
          throw new Error(`Missing value for --${rawKey}.`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}.`);
      }
      if (isKnownOptionToken(nextValue, valueOptions, booleanOptions, aliasMap)) {
        throw new Error(`Missing value for -${shortKey}.`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
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
