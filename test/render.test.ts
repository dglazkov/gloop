import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetLine } from "../src/render.js";

test("budgetLine shows turn and cost against budgets", () => {
	assert.equal(budgetLine(12, 100, 0.34, 5), "turn 12/100 · $0.34/$5.00");
});

test("budgetLine omits infinite turn budget", () => {
	assert.equal(budgetLine(3, Number.POSITIVE_INFINITY, 0.1, 5), "turn 3 · $0.10/$5.00");
});

test("budgetLine omits infinite cost budget", () => {
	assert.equal(budgetLine(3, 100, 0.1, Number.POSITIVE_INFINITY), "turn 3/100 · $0.10");
});
