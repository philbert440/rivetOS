/**
 * Deployment section validator — validates the optional deployment config
 * that drives containerized infrastructure (Docker, Proxmox, Kubernetes).
 */

import {
  KNOWN_DEPLOYMENT_KEYS,
  KNOWN_DEPLOYMENT_DATAHUB_KEYS,
  KNOWN_DEPLOYMENT_IMAGE_KEYS,
  KNOWN_DEPLOYMENT_DOCKER_KEYS,
  KNOWN_DEPLOYMENT_PROXMOX_KEYS,
  KNOWN_DEPLOYMENT_PROXMOX_NODE_KEYS,
  KNOWN_DEPLOYMENT_PROXMOX_NETWORK_KEYS,
  KNOWN_DEPLOYMENT_K8S_KEYS,
  VALID_DEPLOYMENT_TARGETS,
  VALID_PROXMOX_NODE_ROLES,
  type ValidationIssue,
} from './types.js'

/**
 * Validate the deployment section of the config.
 */
export function validateDeployment(
  deployment: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  // Check for unknown keys
  for (const key of Object.keys(deployment)) {
    if (!KNOWN_DEPLOYMENT_KEYS.has(key)) {
      issues.push({
        severity: 'warning',
        path: `deployment.${key}`,
        message: `Unknown deployment key "${key}"`,
      })
    }
  }

  // target (required)
  if (!deployment.target) {
    issues.push({
      severity: 'error',
      path: 'deployment.target',
      message:
        'Missing required field "deployment.target" — must be one of: docker, proxmox, kubernetes, manual',
    })
  } else if (
    typeof deployment.target !== 'string' ||
    !VALID_DEPLOYMENT_TARGETS.has(deployment.target)
  ) {
    issues.push({
      severity: 'error',
      path: 'deployment.target',
      message: `Invalid deployment target "${deployment.target as string}" — must be one of: ${[...VALID_DEPLOYMENT_TARGETS].join(', ')}`,
    })
  }

  // datahub (optional)
  if (deployment.datahub !== undefined) {
    if (
      typeof deployment.datahub !== 'object' ||
      Array.isArray(deployment.datahub) ||
      deployment.datahub === null
    ) {
      issues.push({
        severity: 'error',
        path: 'deployment.datahub',
        message: '"deployment.datahub" must be an object',
      })
    } else {
      validateSubkeys(
        deployment.datahub as Record<string, unknown>,
        'deployment.datahub',
        KNOWN_DEPLOYMENT_DATAHUB_KEYS,
        issues,
      )
    }
  }

  // image (optional)
  if (deployment.image !== undefined) {
    if (
      typeof deployment.image !== 'object' ||
      Array.isArray(deployment.image) ||
      deployment.image === null
    ) {
      issues.push({
        severity: 'error',
        path: 'deployment.image',
        message: '"deployment.image" must be an object',
      })
    } else {
      const image = deployment.image as Record<string, unknown>
      validateSubkeys(image, 'deployment.image', KNOWN_DEPLOYMENT_IMAGE_KEYS, issues)

      if (image.build_from_source !== undefined && typeof image.build_from_source !== 'boolean') {
        issues.push({
          severity: 'error',
          path: 'deployment.image.build_from_source',
          message: '"build_from_source" must be a boolean',
        })
      }
    }
  }

  // docker (optional — only meaningful if target is docker)
  if (deployment.docker !== undefined) {
    if (
      typeof deployment.docker !== 'object' ||
      Array.isArray(deployment.docker) ||
      deployment.docker === null
    ) {
      issues.push({
        severity: 'error',
        path: 'deployment.docker',
        message: '"deployment.docker" must be an object',
      })
    } else {
      const docker = deployment.docker as Record<string, unknown>
      validateSubkeys(docker, 'deployment.docker', KNOWN_DEPLOYMENT_DOCKER_KEYS, issues)

      if (docker.postgres_port !== undefined) {
        if (
          typeof docker.postgres_port !== 'number' ||
          docker.postgres_port < 0 ||
          docker.postgres_port > 65535
        ) {
          issues.push({
            severity: 'error',
            path: 'deployment.docker.postgres_port',
            message: '"postgres_port" must be a number between 0 and 65535',
          })
        }
      }

      if (deployment.target && deployment.target !== 'docker') {
        issues.push({
          severity: 'warning',
          path: 'deployment.docker',
          message: `"deployment.docker" is configured but target is "${deployment.target as string}" — Docker settings will be ignored`,
        })
      }
    }
  }

  // proxmox (optional — only meaningful if target is proxmox)
  if (deployment.proxmox !== undefined) {
    if (
      typeof deployment.proxmox !== 'object' ||
      Array.isArray(deployment.proxmox) ||
      deployment.proxmox === null
    ) {
      issues.push({
        severity: 'error',
        path: 'deployment.proxmox',
        message: '"deployment.proxmox" must be an object',
      })
    } else {
      validateProxmox(deployment.proxmox as Record<string, unknown>, issues)

      if (deployment.target && deployment.target !== 'proxmox') {
        issues.push({
          severity: 'warning',
          path: 'deployment.proxmox',
          message: `"deployment.proxmox" is configured but target is "${deployment.target as string}" — Proxmox settings will be ignored`,
        })
      }
    }
  }

  // kubernetes (optional — only meaningful if target is kubernetes)
  if (deployment.kubernetes !== undefined) {
    if (
      typeof deployment.kubernetes !== 'object' ||
      Array.isArray(deployment.kubernetes) ||
      deployment.kubernetes === null
    ) {
      issues.push({
        severity: 'error',
        path: 'deployment.kubernetes',
        message: '"deployment.kubernetes" must be an object',
      })
    } else {
      validateSubkeys(
        deployment.kubernetes as Record<string, unknown>,
        'deployment.kubernetes',
        KNOWN_DEPLOYMENT_K8S_KEYS,
        issues,
      )

      if (deployment.target && deployment.target !== 'kubernetes') {
        issues.push({
          severity: 'warning',
          path: 'deployment.kubernetes',
          message: `"deployment.kubernetes" is configured but target is "${deployment.target as string}" — Kubernetes settings will be ignored`,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Proxmox validator
// ---------------------------------------------------------------------------

function validateProxmox(proxmox: Record<string, unknown>, issues: ValidationIssue[]): void {
  validateSubkeys(proxmox, 'deployment.proxmox', KNOWN_DEPLOYMENT_PROXMOX_KEYS, issues)

  // nodes
  if (proxmox.nodes !== undefined) {
    if (!Array.isArray(proxmox.nodes)) {
      issues.push({
        severity: 'error',
        path: 'deployment.proxmox.nodes',
        message: '"nodes" must be an array',
      })
    } else {
      let hasDatahub = false
      for (let i = 0; i < proxmox.nodes.length; i++) {
        const node = proxmox.nodes[i] as unknown
        const path = `deployment.proxmox.nodes[${i}]`

        if (!node || typeof node !== 'object' || Array.isArray(node)) {
          issues.push({ severity: 'error', path, message: 'Each node must be an object' })
          continue
        }

        const n = node as Record<string, unknown>
        validateSubkeys(n, path, KNOWN_DEPLOYMENT_PROXMOX_NODE_KEYS, issues)

        if (!n.name || typeof n.name !== 'string') {
          issues.push({
            severity: 'error',
            path: `${path}.name`,
            message: 'Node requires a string "name"',
          })
        }

        if (!n.role || typeof n.role !== 'string' || !VALID_PROXMOX_NODE_ROLES.has(n.role)) {
          issues.push({
            severity: 'error',
            path: `${path}.role`,
            message: `Node role must be one of: ${[...VALID_PROXMOX_NODE_ROLES].join(', ')}`,
          })
        } else if (n.role === 'datahub' || n.role === 'both') {
          hasDatahub = true
        }
      }

      if (proxmox.nodes.length > 0 && !hasDatahub) {
        issues.push({
          severity: 'warning',
          path: 'deployment.proxmox.nodes',
          message:
            'No node has role "datahub" or "both" — at least one node should run the datahub',
        })
      }
    }
  }

  // network
  if (proxmox.network !== undefined) {
    if (
      typeof proxmox.network !== 'object' ||
      Array.isArray(proxmox.network) ||
      proxmox.network === null
    ) {
      issues.push({
        severity: 'error',
        path: 'deployment.proxmox.network',
        message: '"network" must be an object',
      })
    } else {
      validateSubkeys(
        proxmox.network as Record<string, unknown>,
        'deployment.proxmox.network',
        KNOWN_DEPLOYMENT_PROXMOX_NETWORK_KEYS,
        issues,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Generic subkey validator
// ---------------------------------------------------------------------------

function validateSubkeys(
  obj: Record<string, unknown>,
  path: string,
  knownKeys: Set<string>,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!knownKeys.has(key)) {
      issues.push({
        severity: 'warning',
        path: `${path}.${key}`,
        message: `Unknown key "${key}"`,
      })
    }
  }
}
