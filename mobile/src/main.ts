import { bootstrapApplication } from '@angular/platform-browser';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding, withPreloading, PreloadAllModules } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular/standalone';

import { routes } from './app/app.routes';
import { AppComponent } from './app/app.component';
import { jetonInterceptor } from './app/services/auth.service';
import { chargerConfig } from './app/services/config';

// L'adresse de l'API est lue dans assets/config.json avant le démarrage
chargerConfig().then(() =>
  bootstrapApplication(AppComponent, {
    providers: [
      { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
      provideIonicAngular({ mode: 'md' }),
      provideRouter(routes, withPreloading(PreloadAllModules), withComponentInputBinding()),
      provideHttpClient(withInterceptors([jetonInterceptor])),
    ],
  })
);
