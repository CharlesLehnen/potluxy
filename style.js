$(document).ready(function () {
    const formInputs = $('input[type="text"], input[type="password"], input[type="date"], input[type="time"], textarea');

    formInputs.focus(function () {
        $(this).parent().children('p.formLabel').addClass('formTop');
        $('#formWrapper').addClass('darken-bg');
        $('.logo').addClass('logo-active');

        // Change background and h1 color on focus
        $('body').css('background-color', '#333');
        $('h1').css('color', '#44aacc');
    });

    formInputs.focusout(function () {
        if ($.trim($(this).val()).length === 0) {
            $(this).parent().children('p.formLabel').removeClass('formTop');
        }
        $('#formWrapper').removeClass('darken-bg');
        $('.logo').removeClass('logo-active');

        // Revert background and h1 color on focusout
        $('body').css('background-color', '');
        $('h1').css('color', '#2c3e50');
    });

    $('p.formLabel').click(function () {
        $(this).parent().children('.form-style').focus();
    });
});
