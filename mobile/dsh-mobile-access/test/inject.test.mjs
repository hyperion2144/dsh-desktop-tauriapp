import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateInjectionPatch } from '../lib/inject.mjs';

test('generateInjectionPatch 生成包名行注入清单', () => {
  // dsh-mobile-nav 现在走上游子模块（@dsh-external/dsh-mobile-nav），name 含 scope；
  // dsh-mobile-access 保持无 scope。
  const out = generateInjectionPatch([{ id: 'dsh-mobile-nav', name: '@dsh-external/dsh-mobile-nav' }, { id: 'dsh-mobile-access', name: 'dsh-mobile-access' }]);
  assert.ok(out.startsWith('- insert:'));
  assert.ok(out.includes('- id: dsh-mobile-nav\n      name: @dsh-external/dsh-mobile-nav'));
  assert.ok(out.includes('- id: dsh-mobile-access'));
  assert.equal(generateInjectionPatch([]), '');
  assert.equal(generateInjectionPatch([{ id: 'x' }]), '');
});