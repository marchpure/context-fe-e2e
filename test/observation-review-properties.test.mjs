import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProperty } from './support/propHarness.mjs';
import {
  parseRevisionNumber,
  validateLogicalDocumentUpdateObservation,
  validateRepeatedEnrichmentTriggerObservation,
} from './support/observationContracts.mjs';

const file = 'test/observation-review-properties.test.mjs';

test('性质：飞书修订号按实际回执格式解析，声明的预览证据缺失时更新不能通过', () => {
  assertProperty({
    name: '飞书修订与预览证据',
    file,
    seed: 0x9c7032ab,
    runs: 120,
    generate: rng => ({ revision: rng.int(1, 1000), logicalKey: rng.slug('test-doc') }),
  }, ({ revision, logicalKey }) => {
    assert.equal(parseRevisionNumber(`docx_rev:${revision}`), revision);
    const row = { logicalKey, assetId: 'fixture-id', revision };
    const state = {
      before: { rows: [row] },
      after: { rows: [{ ...row, revision: revision + 1 }] },
      updateSpec: { logicalKey, expectedBodySubstring: '合成文档已更新' },
    };
    assert.equal(validateLogicalDocumentUpdateObservation(state).code, 'MISSING_DETAIL_PREVIEW');
    state.after.detailPreview = { bodyText: '合成文档已更新' };
    assert.equal(validateLogicalDocumentUpdateObservation(state).ok, true);
  });
});

test('性质：重复加工触发必须读回同一任务，空观察和串单均不通过', () => {
  assert.equal(validateRepeatedEnrichmentTriggerObservation({ domainId: 'fixture-domain' }).ok, false);
  assertProperty({
    name: '重复加工的任务身份',
    file,
    seed: 0x52d345bf,
    runs: 120,
    generate: rng => ({
      domainId: rng.slug('fixture-domain'),
      runId: rng.slug('run'),
      httpStatus: rng.pick([200, 409]),
      status: rng.pick(['RUNNING', 'QUEUED', 'COMPLETED']),
    }),
  }, ({ domainId, runId, httpStatus, status }) => {
    const state = {
      domainId,
      triggerAttempts: [
        { networkSent: true, httpStatus: 200, runId },
        { networkSent: true, httpStatus, errorCode: 'TaskAlreadyRunning' },
      ],
      runHistoryRows: [{ domainId, runId, status }],
    };
    assert.equal(validateRepeatedEnrichmentTriggerObservation(state).ok, true);
    state.runHistoryRows[0].runId = `${runId}-unrelated`;
    assert.equal(validateRepeatedEnrichmentTriggerObservation(state).code, 'RUN_ID_NOT_OBSERVED');
  });
});
