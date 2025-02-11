// |reftest| skip -- Intl.Locale is not supported
// Copyright 2018 Igalia, S.L. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
esid: sec-intl.locale
description: >
    Verifies the NewTarget check for Intl.Locale.
info: |
    Intl.Locale( tag [, options] )

    1. If NewTarget is undefined, throw a TypeError exception.
features: [Intl.Locale]
---*/

assert.throws(TypeError, function() {
  Intl.Locale();
});

assert.throws(TypeError, function() {
  Intl.Locale("en");
});

reportCompare(0, 0);
