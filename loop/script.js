for (var i = 0; i < 5; i++) {
    setTimeout(function () {
        console.log(i);
    }, 1);
};

for (let n = 0; n < 5; n++) {
    setTimeout(function () {
        console.log(n);
    }, 1);
};