// transformers.js imports sharp at load time for image models only; Milibot runs text embeddings, so
// the daemon bundle gets this stub instead of the native module (it must be truthy to pass the import check).
export default function sharp() {
  throw new Error('image processing is not available in the Milibot daemon')
}
