import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEvaluationReportView,
  validateWorkbenchReadyView,
} from '../lib/ui-checks.mjs';

test('已打开调试台但没有可用版本时不会通过', () => {
  assert.throws(() => validateWorkbenchReadyView({
    chatTabActive: true,
    domainPicker: { visible: true, width: 160, height: 32, disabled: true },
    modelPicker: { visible: true, width: 160, height: 32, text: '合成默认模型' },
    composer: { visible: true, width: 400, height: 100 },
  }), /业务领域与版本.*禁用/);
});

test('评测总评通过但逐题仍失败时明确报错', () => {
  assert.throws(() => classifyEvaluationReportView({
    badges: ['双轮评测通过'],
    rows: [{ question: '合成退款时效', verdict: '待改进' }],
  }), /逐题明细存在未通过项/);
});
