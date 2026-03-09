import { InferenceSession } from 'onnxruntime-react-native';
import { Asset } from 'expo-asset';

let session: InferenceSession | null = null;

export async function loadModel(): Promise<void> {
  if (session) return;

  // Load the bundled ONNX model asset
  const asset = Asset.fromModule(require('../../assets/model.onnx'));
  await asset.downloadAsync();

  if (!asset.localUri) {
    throw new Error('Failed to download model asset');
  }

  console.log(`Loading ONNX model from: ${asset.localUri}`);
  session = await InferenceSession.create(asset.localUri);
  console.log('ONNX model loaded successfully');
}

export function getSession(): InferenceSession {
  if (!session) throw new Error('Model not loaded. Call loadModel() first.');
  return session;
}

export function isModelLoaded(): boolean {
  return session !== null;
}

export async function releaseModel(): Promise<void> {
  if (session) {
    await session.release();
    session = null;
  }
}
