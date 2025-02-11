// Test importing module namespaces

"use strict";

load(libdir + "asserts.js");
load(libdir + "iteration.js");
load(libdir + "dummyModuleResolveHook.js");

function parseAndEvaluate(source) {
    let m = parseModule(source);
    instantiateModule(m);
    return evaluateModule(m);
}

function testHasNames(names, expected) {
    assertEq(names.length, expected.length);
    expected.forEach(function(name) {
        assertEq(names.includes(name), true);
    });
}

function testEqualArrays(actual, expected) {
	assertEq(Array.isArray(actual), true);
	assertEq(Array.isArray(expected), true);
    assertEq(actual.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
    	assertEq(actual[i], expected[i]);
    }
}

let a = moduleRepo['a'] = parseModule(
    `// Reflection methods should return these exports alphabetically sorted.
     export var b = 2;
     export var a = 1;`
);

let b = moduleRepo['b'] = parseModule(
    `import * as ns from 'a';
     export { ns };
     export var x = ns.a + ns.b;`
);

instantiateModule(b);
evaluateModule(b);
testHasNames(getModuleEnvironmentNames(b), ["ns", "x"]);
let ns = getModuleEnvironmentValue(b, "ns");
testHasNames(Object.keys(ns), ["a", "b"]);
assertEq(ns.a, 1);
assertEq(ns.b, 2);
assertEq(ns.c, undefined);
assertEq(getModuleEnvironmentValue(b, "x"), 3);

// Test module namespace internal methods as defined in 9.4.6
assertEq(Object.getPrototypeOf(ns), null);
assertEq(Reflect.setPrototypeOf(ns, null), true);
assertEq(Reflect.setPrototypeOf(ns, Object.prototype), false);
assertThrowsInstanceOf(() => Object.setPrototypeOf(ns, {}), TypeError);
assertThrowsInstanceOf(function() { ns.foo = 1; }, TypeError);
assertEq(Object.isExtensible(ns), false);
Object.preventExtensions(ns);
let desc = Object.getOwnPropertyDescriptor(ns, "a");
assertEq(desc.value, 1);
assertEq(desc.writable, true);
assertEq(desc.enumerable, true);
assertEq(desc.configurable, false);
assertEq(typeof desc.get, "undefined");
assertEq(typeof desc.set, "undefined");
assertThrowsInstanceOf(function() { ns.a = 1; }, TypeError);
delete ns.foo;
assertThrowsInstanceOf(function() { delete ns.a; }, TypeError);

// Test @@toStringTag property
desc = Object.getOwnPropertyDescriptor(ns, Symbol.toStringTag);
assertEq(desc.value, "Module");
assertEq(desc.writable, false);
assertEq(desc.enumerable, false);
assertEq(desc.configurable, false);
assertEq(typeof desc.get, "undefined");
assertEq(typeof desc.set, "undefined");
assertEq(Object.prototype.toString.call(ns), "[object Module]");

// Test [[OwnPropertyKeys]] internal method.
testEqualArrays(Reflect.ownKeys(ns), ["a", "b", Symbol.toStringTag]);
testEqualArrays(Object.getOwnPropertyNames(ns), ["a", "b"]);
testEqualArrays(Object.getOwnPropertySymbols(ns), [Symbol.toStringTag]);

// Test cyclic namespace import and access in module evaluation.
let c = moduleRepo['c'] =
    parseModule("export let c = 1; import * as ns from 'd'; let d = ns.d;");
let d = moduleRepo['d'] =
    parseModule("export let d = 2; import * as ns from 'c'; let c = ns.c;");
instantiateModule(c);
instantiateModule(d);
assertThrowsInstanceOf(() => evaluateModule(c), ReferenceError);

// Test cyclic namespace import.
let e = moduleRepo['e'] =
    parseModule("export let e = 1; import * as ns from 'f'; export function f() { return ns.f }");
let f = moduleRepo['f'] =
    parseModule("export let f = 2; import * as ns from 'e'; export function e() { return ns.e }");
instantiateModule(e);
instantiateModule(f);
evaluateModule(e);
evaluateModule(f);
assertEq(getModuleObject(e).namespace.f(), 2);
assertEq(getModuleObject(f).namespace.e(), 1);
