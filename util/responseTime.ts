import { Request, Response, NextFunction } from 'express';

// Middleware per calcolare il tempo di risposta
function calculateResponseTimeMiddleware(req: Request, res: Response, next: NextFunction) {
  if(req.method !== "OPTIONS"){
    const start = process.hrtime();
  
    res.on('finish', () => {
      const end = process.hrtime(start);
      const responseTimeInMilliseconds = Math.floor((end[0] * 1000) + (end[1] / 1e6));
      console.log(`Richiesta ${req.method} ${req.path} ha impiegato ${responseTimeInMilliseconds} ms`);
    });
  }

  next();
}

export default calculateResponseTimeMiddleware;