import { describe, test, expect } from 'bun:test';
import { validatePort } from '../../src/utils/validation.js';

describe('validatePort', () => {
  test('accepts whole numbers in range', () => {
    expect(validatePort('1', false)).toBe(1);
    expect(validatePort('3000', false)).toBe(3000);
    expect(validatePort('65535', false)).toBe(65535);
  });

  test('rejects anything that is not exactly a port number', () => {
    for (const bad of ['0', '65536', '-1', '3000abc', '30.5', '', ' ', 'abc', '1e3']) {
      expect(validatePort(bad, false)).toBeNull();
    }
  });
});
