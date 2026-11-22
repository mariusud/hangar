# hello

The smallest Expo app for trying `devicepool run ios`. It shows a title and a counter.

```bash
npm install
npx expo prebuild -p ios
devicepool run ios
```

Tap the button a few times, then change the title in `App.tsx` and save. The leased simulator
shows the new title and keeps the count.
