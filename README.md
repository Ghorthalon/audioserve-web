# Experimental new audioserve web client 
**[DEMO AVAILABLE](https://audioserve-new.zderadicka.eu) (shared secret: mypass)**
  
Main motivation is to try new technologies, so [Svelte](https://svelte.dev) and [TypeScript](https://www.typescriptlang.org/) are used as main languages and [PWA](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps) technologies are used.

Now key focus is on efficient caching of audio files, something similar what is available in [Android client](https://github.com/izderadicka/audioserve-android) - so Service Worker and CacheStorage is used.

My idea is that this application should fully replace mobile (Android), client.

As per now it's still 'Work In Progress',  most things are working, I'm already using it for some time and curious and fearless user are welcomed to try. I'm definitely **interested in feedback** so you can log issues on this project.

For now works better in Chrome/Chromium, but Firefox should be also fine most of the time (ServiceWorker seems to be more "stable" in Chrome).

## How to use?

You will need audioserve server running somewhere with this client. There are multiple options:

- use `izderadicka/audioserve:experimental` image from dockerhub. But it may not be latest client, as it'is not build automatically yet
  
- clone this project and build client:

```
npm install && npm run build && npm run build-sw
```
then either copy and replace classic web client in client directory of audioserve, or use argument `--client-dir` to use directory with with client.

- build your own audioserve image with `--build-arg NEW_CLIENT=1`

## License 
MIT

## Generated code for src/client

Code for client API is generated by [OpenApi Generator](https://github.com/OpenAPITools/openapi-generator) using following command:

```
java -jar openapi-generator-cli.jar generate -i ~/workspace/audioserve/docs/audioserve-api-v1.yaml -g typescript-fetch -o ./client --additional-properties=typescriptThreePlus=true
```

However there is a bug in generated code (because endpoint /positions/{group}/{colId}/{path} can return either position or array of positions, which is not handled correctly by generator). So had to provide manual fix for PositionsApi.ts line 111



