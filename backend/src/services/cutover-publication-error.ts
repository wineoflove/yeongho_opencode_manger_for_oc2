export class CutoverPublicationUncertainError extends Error {
  constructor() {
    super('CUTOVER_PUBLICATION_UNCERTAIN')
    this.name = 'CutoverPublicationUncertainError'
  }
}
