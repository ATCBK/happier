import { readThroughConsumer } from './bridge';

export const value = 'original';
export const readThroughCycle = () => readThroughConsumer();
