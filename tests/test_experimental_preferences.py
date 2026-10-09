import unittest
from xueness.bundled_plugins.settings.preferences import validate


class ExperimentalPreferencesTests(unittest.TestCase):
    def test_default_off_flags_require_actual_booleans(self):
        self.assertEqual(validate('general', {}), {})
        for key in ('sessionsEventsCursorEnabled', 'sessionsEventResumeEnabled',
                    'sessionsCancelReceiptEnabled',
                    'sessionsAnswerQuestionEnabled',
                    'toolsDryRunEnabled', 'toolsCallBudgetEnabled'):
            for value in (False, True):
                self.assertEqual(validate('general', {key: value}), {key: value})
            for value in (0, 1, 'true', None, []):
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    validate('general', {key: value})

    def test_budget_limit_rejects_bool_fraction_and_out_of_range(self):
        for value in (1, 100, 10000):
            self.assertEqual(validate('general', {'toolsCallBudgetLimit': value}), {'toolsCallBudgetLimit': value})
        for value in (False, True, 0, 10001, 1.5, '100', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate('general', {'toolsCallBudgetLimit': value})
