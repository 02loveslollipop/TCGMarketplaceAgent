import '@testing-library/jest-dom/vitest';
import {afterEach} from 'vitest';
import {cleanup} from '@testing-library/react';
afterEach(cleanup);
globalThis.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}};
if (typeof window !== 'undefined') window.matchMedia=()=>({matches:false,media:'',onchange:null,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true;}});
