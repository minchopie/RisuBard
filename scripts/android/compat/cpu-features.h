// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <stdint.h>
#define ANDROID_CPU_ARM64_FEATURE_CRC32 UINT64_C(1)
#define ANDROID_CPU_ARM64_FEATURE_PMULL UINT64_C(2)
// shortcut: optional zlib ARM acceleration is disabled; revisit when tuning compression.
static inline uint64_t android_getCpuFeatures(void) { return UINT64_C(0); }
