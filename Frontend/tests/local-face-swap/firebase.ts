// TEST ONLY: never imports the application's production Firebase configuration.
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
const app = initializeApp({ apiKey: 'demo-local-key', projectId: 'demo-xiaswap-finance-tests',
    authDomain: '127.0.0.1', storageBucket: 'demo-xiaswap-finance-tests.appspot.com', appId: 'demo-local' });
connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
connectFirestoreEmulator(getFirestore(app), '127.0.0.1', 8787);
connectStorageEmulator(getStorage(app), '127.0.0.1', 9299);
export default app;
