import { FIELDS } from '../../workbench/schema-fields.mjs'

export const schema = {
  knowledge: {
    title: { ...FIELDS.title, required: true },
    body: { ...FIELDS.body, default: '' },
    knowledgeBaseId: { ...FIELDS.recordId, default: '' },
    folderId: { ...FIELDS.recordId, default: '' },
  },
  knowledgeBases: {
    title: { ...FIELDS.title, required: true },
    description: { ...FIELDS.note, default: '' },
  },
  knowledgeFolders: {
    title: { ...FIELDS.title, required: true },
    knowledgeBaseId: { ...FIELDS.recordId, required: true },
    parentId: { ...FIELDS.recordId, default: '' },
  },
}
