import { Tracer } from './tracer';

// Create a shared tracer instance
let tracer: Tracer | null = null;

export const getTracer = () => {
    return tracer;
};

export const setTracer = (setTracer: Tracer) => {
    tracer = setTracer;
}; 