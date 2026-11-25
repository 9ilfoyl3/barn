import { z } from 'zod'

export const memorySearchInput = z.object({
  query: z.string().max(1_000).default(''),
  scope: z.enum(['all', 'global', 'workspace']).default('all'),
  limit: z.number().int().positive().max(20).default(8),
})

export const memorySaveInput = z.object({
  kind: z.enum(['preference', 'fact', 'procedure', 'decision', 'project']),
  scope: z.enum(['global', 'workspace']).default('workspace'),
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(2_000),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  key: z.string().min(1).max(100).optional(),
  pinned: z.boolean().default(false),
  expectedVersion: z.number().int().positive().optional(),
})

export const memoryUpdateInput = z.object({
  id: z.uuid(),
  expectedVersion: z.number().int().positive(),
  title: z.string().min(1).max(120).optional(),
  content: z.string().min(1).max(2_000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  pinned: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  validUntil: z.string().nullable().optional(),
})

export const memoryForgetInput = z.object({
  id: z.uuid(),
})
