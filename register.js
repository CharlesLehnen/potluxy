<script type="module">
  // Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
  import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-analytics.js";
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: "AIzaSyCuG4hjJiaDsklq3FNhjcVW76_S70cBsdc",
    authDomain: "potlucky-f5b95.firebaseapp.com",
    projectId: "potlucky-f5b95",
    storageBucket: "potlucky-f5b95.appspot.com",
    messagingSenderId: "415540003596",
    appId: "1:415540003596:web:2b31d3144c6c5b14c63f29",
    measurementId: "G-85WKC57ZDT"
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  const analytics = getAnalytics(app);
</script>