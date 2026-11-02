{
  "rules": {
    // OPTIONAL: Cloud Function ke bina swap ko tamper-proof banane ke liye.
    // Firebase Console > Realtime Database > Rules me paste karne se pehle
    // "Rules Playground" me test karo. Ye sirf aapke swap ke liye likhe gaye hain.
    //
    // WARNING: Ye rules client se rndWallet badhne aur depositWallet /
    // referralWallet ko rate se zyada badhne se rokte hain. Agar aapke dusre
    // pages (deposit, referral, mining etc.) client se inhe BADHATE hain,
    // to wo bhi block ho jayenge. Aise me unke hisab se rules badalne honge.

    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid",

        "rndWallet": {
          ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= data.val()"
        },

        "depositWallet": {
          ".validate": "newData.isNumber() && newData.val() >= 0 && (!data.exists() || newData.val() <= data.val() || (newData.val() - data.val()) <= (data.parent().child('rndWallet').val() - newData.parent().child('rndWallet').val()) * (root.child('settings/rate').val() + 0.05) + 0.011)"
        },

        "referralWallet": {
          ".validate": "newData.isNumber() && newData.val() >= 0 && (!data.exists() || newData.val() <= data.val() || (newData.val() - data.val()) <= (data.parent().child('rndWallet').val() - newData.parent().child('rndWallet').val()) * (root.child('settings/rate').val() + 0.05) + 0.011)"
        }
      }
    },

    "settings": {
      ".read": "auth != null"
    }
  }
}
