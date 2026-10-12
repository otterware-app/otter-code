import { z } from 'zod'

export const actorSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['user', 'api_key']),
})
export type Actor = z.infer<typeof actorSchema>

export const artifactFileSchema = z.object({
  path: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
})
export type ArtifactFile = z.infer<typeof artifactFileSchema>

export const artifactVersionSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  label: z.string(),
  entryPath: z.string(),
  createdAt: z.string().datetime(),
  createdBy: actorSchema.nullable(),
  fileCount: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
  contentHash: z.string(),
})
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>

export const artifactPreviewSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
  version: artifactVersionSchema,
  contentType: z.string(),
  resourceBaseUrl: z.string().url(),
})
export const artifactPreviewResponseSchema = z.object({
  data: artifactPreviewSchema,
})
export type ArtifactPreviewResponse = z.infer<
  typeof artifactPreviewResponseSchema
>

export const artifactSchema = z.object({
  id: z.string(),
  folderId: z.string(),
  /** Legacy CLI response field; this is the folder ID. */
  organizationId: z.string().optional(),
  ownerUserId: z.string().nullable(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
  currentVersion: artifactVersionSchema.nullable(),
  versionCount: z.number().int().nonnegative(),
  url: z.string(),
  thumbnailUrl: z.string().nullable().optional(),
  /** Your access: through the document's folder or its own sharing. */
  role: z.enum(['owner', 'editor', 'viewer']).optional(),
  /** Shared with people outside its drive, or through a link. */
  shared: z.boolean().optional(),
})
export type Artifact = z.infer<typeof artifactSchema>

export const artifactBootstrapResponseSchema = z.object({
  data: z.object({
    artifact: artifactSchema,
    versions: z.array(artifactVersionSchema),
    preview: artifactPreviewSchema,
  }),
})
export type ArtifactBootstrapResponse = z.infer<
  typeof artifactBootstrapResponseSchema
>

export const paginationSchema = z.object({
  nextCursor: z.string().nullable(),
})

export const artifactListResponseSchema = z.object({
  data: z.array(artifactSchema),
  pagination: paginationSchema,
})
export type ArtifactListResponse = z.infer<typeof artifactListResponseSchema>

export const artifactResponseSchema = z.object({ data: artifactSchema })
export type ArtifactResponse = z.infer<typeof artifactResponseSchema>

export const artifactVersionsResponseSchema = z.object({
  data: z.array(artifactVersionSchema),
  pagination: paginationSchema,
})
export type ArtifactVersionsResponse = z.infer<
  typeof artifactVersionsResponseSchema
>

export const artifactFilesResponseSchema = z.object({
  data: z.array(artifactFileSchema),
})
export type ArtifactFilesResponse = z.infer<typeof artifactFilesResponseSchema>

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const createArtifactInputSchema = z.object({
  slug: z.string().min(1).max(80).regex(slugPattern),
  title: z.string().min(1).max(200),
  description: z.string().max(2_000).default(''),
  entryPath: z.string().min(1).default('index.html'),
  label: z.string().min(1).max(300).default('Initial version'),
})
export type CreateArtifactInput = z.infer<typeof createArtifactInputSchema>

export const updateArtifactInputSchema = z
  .object({
    slug: z.string().min(1).max(80).regex(slugPattern).optional(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2_000).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, 'No updates supplied')
export type UpdateArtifactInput = z.infer<typeof updateArtifactInputSchema>

export const moveArtifactInputSchema = z.preprocess(
  (value) => {
    if (
      value &&
      typeof value === 'object' &&
      'organizationId' in value &&
      !('folderId' in value)
    )
      return { ...value, folderId: value.organizationId }
    return value
  },
  z.object({ folderId: z.string().min(1) }),
)
export type MoveArtifactInput = z.infer<typeof moveArtifactInputSchema>

export const createUploadInputSchema = z.object({
  label: z.string().min(1).max(300),
  entryPath: z.string().min(1),
  expectedCurrentVersion: z.number().int().nonnegative().optional(),
  /** Carry forward unchanged files from this version when publishing edits. */
  baseVersion: z.number().int().positive().optional(),
  files: z
    .array(
      artifactFileSchema.extend({
        path: z
          .string()
          .min(1)
          .refine((value) => !value.startsWith('/') && !value.includes('..')),
      }),
    )
    .min(1),
})
export type CreateUploadInput = z.infer<typeof createUploadInputSchema>

export const uploadSessionSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  expiresAt: z.string().datetime(),
  files: z.array(
    z.object({
      path: z.string(),
      uploadUrl: z.string(),
      multipart: z.boolean().default(false),
      partSize: z.number().int().positive().optional(),
    }),
  ),
})
export type UploadSession = z.infer<typeof uploadSessionSchema>

export const uploadSessionResponseSchema = z.object({
  data: uploadSessionSchema,
})

export const multipartUploadPartResponseSchema = z.object({
  data: z.object({
    partNumber: z.number().int().positive(),
    etag: z.string().min(1),
  }),
})

export const completeUploadResponseSchema = z.object({
  data: z.object({
    artifact: artifactSchema,
    version: artifactVersionSchema,
  }),
})
export type CompleteUploadResponse = z.infer<
  typeof completeUploadResponseSchema
>

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
})
export type ApiError = z.infer<typeof apiErrorSchema>

export const deviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number().optional(),
})

export const deviceTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
})

export type ApiSuccess<T> = { data: T }

export const API_VERSION = 'v1'
export const DEFAULT_API_URL = 'https://drive.otterware.app'

export const folderSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  parentId: z.string().nullable(),
  kind: z.enum(['personal', 'shared', 'folder']),
  ownerUserId: z.string(),
  role: z.enum(['owner', 'editor', 'viewer']),
  /** Shared with people outside its drive, or through a link. */
  shared: z.boolean().optional(),
})
export type Folder = z.infer<typeof folderSchema>
export const folderListResponseSchema = z.object({
  data: z.array(folderSchema),
})
export const createFolderInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: z.string().min(1).optional(),
  kind: z.enum(['shared', 'folder']).default('folder'),
})
export const updateFolderInputSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  parentId: z.string().min(1).optional(),
})
export const inviteDriveMemberInputSchema = z.object({
  email: z.email().trim().max(254),
  role: z.enum(['viewer', 'editor']),
})
export const driveMemberSchema = z.object({
  id: z.string(),
  email: z.email(),
  role: z.enum(['viewer', 'editor']),
  userId: z.string().nullable(),
})
export const driveMembersResponseSchema = z.object({
  data: z.array(driveMemberSchema),
})

export const transferDriveInputSchema = z.object({ userId: z.string().min(1) })

// ---------------------------------------------------------------------------
// Sharing (Google Drive's model): a folder, with everything inside it, or a
// single document is shared with people by email as a viewer or an editor,
// or with anyone who has its link. Shared drive members have access to the
// whole drive; sharing never makes someone a member.
// ---------------------------------------------------------------------------

export const shareRoleSchema = z.enum(['viewer', 'editor'])
export type ShareRole = z.infer<typeof shareRoleSchema>

export const personSchema = z.object({
  /** Null until the person signs in to Drive with this email. */
  userId: z.string().nullable(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
})
export type Person = z.infer<typeof personSchema>

export const accessEntrySchema = personSchema.extend({
  /** The share, or the drive membership for a shared drive itself. */
  id: z.string(),
  role: shareRoleSchema,
  /** The folder whose sharing grants this access; null when granted here. */
  inheritedFrom: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** They opened the link rather than being added by name. */
  viaLink: z.boolean(),
})
export type AccessEntry = z.infer<typeof accessEntrySchema>

export const sharingSchema = z.object({
  resource: z.object({
    type: z.enum(['folder', 'artifact']),
    id: z.string(),
    name: z.string(),
    /** A drive itself is shared by managing its members. */
    folderKind: z.enum(['personal', 'shared', 'folder']).nullable(),
  }),
  /** The drive it lives in. A shared drive's members all have access. */
  drive: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(['personal', 'shared']),
    memberCount: z.number().int().nonnegative(),
  }),
  owner: personSchema,
  /** Your access to it. */
  role: z.enum(['owner', 'editor', 'viewer']),
  /** You may add people, change their access and set the link. */
  canShare: z.boolean(),
  people: z.array(accessEntrySchema),
  link: z.object({ url: z.string(), role: shareRoleSchema }).nullable(),
  /** A link on a folder above it that also opens it. */
  inheritedLink: z
    .object({
      folderId: z.string(),
      folderName: z.string(),
      role: shareRoleSchema,
    })
    .nullable(),
})
export type Sharing = z.infer<typeof sharingSchema>

export const sharingResponseSchema = z.object({
  data: sharingSchema,
  /** The people just added were emailed. */
  notified: z.boolean().optional(),
})
export type SharingResponse = z.infer<typeof sharingResponseSchema>

export const createSharesInputSchema = z.object({
  emails: z.array(z.email().trim().max(254)).min(1).max(20),
  role: shareRoleSchema,
  notify: z.boolean().default(true),
  message: z.string().trim().max(1_000).optional(),
})
export type CreateSharesInput = z.infer<typeof createSharesInputSchema>

export const updateShareInputSchema = z.object({ role: shareRoleSchema })

export const shareLinkInputSchema = z.object({ role: shareRoleSchema })

export const sharedItemSchema = z.object({
  type: z.enum(['folder', 'artifact']),
  /** Your access to it. */
  role: z.enum(['owner', 'editor', 'viewer']),
  sharedAt: z.string(),
  sharedBy: personSchema.nullable(),
  owner: personSchema,
  /** Where the folder sits, or the document's folder. */
  folderSlug: z.string(),
  folder: folderSchema.optional(),
  artifact: artifactSchema.optional(),
})
export type SharedItem = z.infer<typeof sharedItemSchema>

export const sharedWithMeResponseSchema = z.object({
  data: z.array(sharedItemSchema),
})

export const acceptLinkResponseSchema = z.object({
  data: z.object({
    type: z.enum(['folder', 'artifact']),
    folderId: z.string(),
    folderSlug: z.string(),
    /** The document's slug, for an artifact link. */
    slug: z.string().nullable(),
  }),
})
export type AcceptLinkResponse = z.infer<typeof acceptLinkResponseSchema>

export const peopleResponseSchema = z.object({ data: z.array(personSchema) })

// ---------------------------------------------------------------------------
// Storage: the buckets a drive keeps its documents in. Without one, files live
// in Otterware's own storage. Credentials go in and never come back out.
// ---------------------------------------------------------------------------

export const storageProviderSchema = z.enum(['s3', 'gcs', 'azure'])
export type StorageProvider = z.infer<typeof storageProviderSchema>

/** Where a bucket's files go: never credentials. */
export const storageLocationSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('s3'),
    bucket: z.string(),
    region: z.string(),
    /** Absent for Amazon S3; R2, B2, MinIO and others set theirs. */
    endpoint: z.string().nullable(),
    pathStyle: z.boolean(),
    prefix: z.string(),
  }),
  z.object({
    provider: z.literal('gcs'),
    bucket: z.string(),
    prefix: z.string(),
  }),
  z.object({
    provider: z.literal('azure'),
    account: z.string(),
    container: z.string(),
    endpoint: z.string().nullable(),
    prefix: z.string(),
  }),
])
export type StorageLocation = z.infer<typeof storageLocationSchema>

export const storageBackendSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: storageLocationSchema,
  /** New uploads in the drive go here. */
  isDefault: z.boolean(),
  /** Files stored in it, every version counted. */
  fileCount: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
  createdAt: z.string(),
  /** When a write, read and delete last succeeded. */
  verifiedAt: z.string().nullable(),
})
export type StorageBackend = z.infer<typeof storageBackendSchema>

export const driveStorageSchema = z.object({
  /** Null: new uploads go to Otterware's storage. */
  defaultBackendId: z.string().nullable(),
  /** Files still in Otterware's storage. */
  otterware: z.object({
    fileCount: z.number().int().nonnegative(),
    byteSize: z.number().int().nonnegative(),
  }),
  backends: z.array(storageBackendSchema),
})
export type DriveStorage = z.infer<typeof driveStorageSchema>
export const driveStorageResponseSchema = z.object({ data: driveStorageSchema })

const prefixSchema = z
  .string()
  .max(200)
  .regex(/^[^\\]*$/, 'Use forward slashes in the prefix.')
  .transform((value) => {
    const trimmed = value.trim().replace(/^\/+/, '')
    return trimmed && !trimmed.endsWith('/') ? `${trimmed}/` : trimmed
  })
  .optional()
const endpointSchema = z
  .string()
  .trim()
  .url()
  .transform((value) => value.replace(/\/+$/, ''))
  .optional()
const secretSchema = z.string().trim().min(1).max(4096)

export const createStorageBackendInputSchema = z.discriminatedUnion(
  'provider',
  [
    z.object({
      provider: z.literal('s3'),
      name: z.string().trim().min(1).max(80),
      bucket: z.string().trim().min(1).max(255),
      region: z.string().trim().min(1).max(64).default('us-east-1'),
      endpoint: endpointSchema,
      /** Defaults to path style for a custom endpoint, virtual hosts for AWS. */
      pathStyle: z.boolean().optional(),
      prefix: prefixSchema,
      accessKeyId: secretSchema,
      secretAccessKey: secretSchema,
      makeDefault: z.boolean().optional(),
    }),
    z.object({
      provider: z.literal('gcs'),
      name: z.string().trim().min(1).max(80),
      bucket: z.string().trim().min(1).max(255),
      prefix: prefixSchema,
      /** An HMAC key for a service account (Cloud Storage → Interoperability). */
      accessKeyId: secretSchema,
      secretAccessKey: secretSchema,
      makeDefault: z.boolean().optional(),
    }),
    z
      .object({
        provider: z.literal('azure'),
        name: z.string().trim().min(1).max(80),
        account: z.string().trim().min(1).max(64),
        container: z.string().trim().min(1).max(63),
        endpoint: endpointSchema,
        prefix: prefixSchema,
        accountKey: secretSchema.optional(),
        sasToken: secretSchema.optional(),
        makeDefault: z.boolean().optional(),
      })
      .refine(
        (value) => Boolean(value.accountKey) !== Boolean(value.sasToken),
        {
          message: 'Give either an account key or a SAS token.',
          path: ['accountKey'],
        },
      ),
  ],
)
export type CreateStorageBackendInput = z.input<
  typeof createStorageBackendInputSchema
>

export const updateDriveStorageInputSchema = z.object({
  defaultBackendId: z.string().nullable(),
})

export const storageBackendResponseSchema = z.object({
  data: storageBackendSchema,
})
