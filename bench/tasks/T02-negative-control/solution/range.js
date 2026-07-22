export function clamp(value, min, max) {
  if (min > max) {
    throw new RangeError("min must not exceed max");
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function normalize(value, min, max) {
  if (max === min) {
    throw new RangeError("max must be greater than min");
  }
  return (clamp(value, min, max) - min) / (max - min);
}

export function lerp(t, min, max) {
  return min + t * (max - min);
}
