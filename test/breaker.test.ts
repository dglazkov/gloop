import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsecutiveFailureBreaker } from "../src/breaker.js";

test("a single failure does not trip the breaker", () => {
	const breaker = new ConsecutiveFailureBreaker(2);
	assert.equal(breaker.recordFailure(), false);
});

test("two consecutive failures trip the breaker", () => {
	const breaker = new ConsecutiveFailureBreaker(2);
	assert.equal(breaker.recordFailure(), false);
	assert.equal(breaker.recordFailure(), true);
});

test("a success between failures resets the streak", () => {
	const breaker = new ConsecutiveFailureBreaker(2);
	assert.equal(breaker.recordFailure(), false);
	breaker.recordSuccess();
	assert.equal(breaker.recordFailure(), false);
	assert.equal(breaker.recordFailure(), true);
});

test("stays tripped on further failures", () => {
	const breaker = new ConsecutiveFailureBreaker(2);
	breaker.recordFailure();
	breaker.recordFailure();
	assert.equal(breaker.recordFailure(), true);
});

test("defaults to a limit of two", () => {
	const breaker = new ConsecutiveFailureBreaker();
	assert.equal(breaker.recordFailure(), false);
	assert.equal(breaker.recordFailure(), true);
});

test("rejects a limit below one", () => {
	assert.throws(() => new ConsecutiveFailureBreaker(0), /limit must be >= 1/);
});
